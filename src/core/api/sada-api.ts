import { ApiError } from "../errors";
import type { WhipSignaling } from "../transport/whip";
import type { Credentials, SessionInfo, StreamMeta, StudioApi } from "./types";

const API = "/api/v1";
const SDP = "application/sdp";
const ICE = "application/trickle-ice-sdpfrag";

/** Normalise l'adresse saisie : https par défaut, http seulement en local, sans chemin ni barre finale. */
export function normalizeBaseUrl(input: string): string {
  const raw = input.trim();
  if (!raw) throw new ApiError(0, "Adresse de l'instance manquante.");
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new ApiError(0, "Adresse de l'instance invalide.");
  }
  const local = /^(localhost|127\.0\.0\.1|\[::1\]|.+\.local)$/.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new ApiError(0, "L'adresse doit commencer par https:// (http n'est admis qu'en local).");
  }
  return url.origin;
}

/** Cookies de session, conservés à la main : le processus Node n'a pas de pot à cookies. */
class CookieJar {
  private readonly cookies = new Map<string, string>();

  store(res: Response) {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq < 1) continue;
      const name = pair.slice(0, eq).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || pair.slice(eq + 1) === "";
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, pair.slice(eq + 1).trim());
    }
  }

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  clear() {
    this.cookies.clear();
  }
}

export interface SadaApiOptions {
  fetch?: typeof fetch;
}

/** Client HTTP de la console Sada (session par cookie + jeton X-CSRF). Tourne dans Node comme dans un navigateur. */
export class SadaHttpApi implements StudioApi {
  private readonly doFetch: typeof fetch;
  private readonly jar = new CookieJar();
  private credentials: Credentials | null = null;
  private baseUrl = "";
  private csrf = "";
  private mosqueId: number | null = null;
  private reauth: Promise<void> | null = null;

  constructor(options: SadaApiOptions = {}) {
    this.doFetch = options.fetch ?? ((...a) => fetch(...a));
  }

  async login(credentials: Credentials): Promise<SessionInfo> {
    const baseUrl = normalizeBaseUrl(credentials.baseUrl);
    this.jar.clear();
    const challenge = await this.send<{ pre: string }>("GET", "/login-challenge", { baseUrl, auth: false });
    const body = new URLSearchParams({ username: credentials.username.trim(), password: credentials.password, pre: challenge.pre });
    let session: SessionInfo;
    try {
      session = await this.send<SessionInfo>("POST", "/login", {
        baseUrl,
        auth: false,
        body,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) throw new ApiError(401, "Identifiant ou mot de passe incorrect.");
      if (e instanceof ApiError && e.status === 429) throw new ApiError(429, "Trop de tentatives. Réessayez dans quelques minutes.");
      throw e;
    }
    this.baseUrl = baseUrl;
    this.credentials = { ...credentials, baseUrl };
    this.csrf = session.csrf;
    this.mosqueId = session.mosque?.id ?? null;
    return normalizeSession(session);
  }

  async selectMosque(mosqueId: number): Promise<SessionInfo> {
    const session = await this.send<SessionInfo>("POST", "/mosques/select", { json: { mosque_id: mosqueId } });
    this.csrf = session.csrf || this.csrf;
    this.mosqueId = mosqueId;
    return normalizeSession(session);
  }

  async logout(): Promise<void> {
    if (this.baseUrl) await this.send("POST", "/logout", { retry: false }).catch(() => undefined);
    this.jar.clear();
    this.credentials = null;
    this.csrf = "";
    this.mosqueId = null;
  }

  async announce(_meta: StreamMeta): Promise<void> {
    // Pas de point d'accès côté Sada pour l'instant : le type et le titre restent locaux à l'application.
  }

  readonly whip: WhipSignaling = {
    offer: async (sdp) => {
      const res = await this.raw("POST", `${API}/live/studio/whip`, { body: sdp, headers: { "Content-Type": SDP } });
      const location = res.headers.get("location");
      if (res.status !== 201 || !location) throw new ApiError(res.status, `Réponse WHIP inattendue (${res.status}).`);
      return { answer: await res.text(), resource: this.sameOriginPath(location) };
    },
    patchIce: async (resource, fragment) => {
      await this.raw("PATCH", resource, { body: fragment, headers: { "Content-Type": ICE } });
    },
    close: async (resource) => {
      await this.raw("DELETE", resource, {});
    },
  };

  /** Seul un chemin de la même instance est suivi : un Location extérieur ne reçoit jamais le cookie. */
  private sameOriginPath(location: string): string {
    const u = new URL(location, this.baseUrl);
    if (u.origin !== this.baseUrl) throw new ApiError(502, "Ressource WHIP hors de l'instance.");
    return u.pathname;
  }

  private async send<T>(
    method: string,
    path: string,
    o: { baseUrl?: string; auth?: boolean; json?: unknown; body?: BodyInit; headers?: Record<string, string>; retry?: boolean } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json", ...o.headers };
    let body = o.body;
    if (o.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(o.json);
    }
    const res = await this.raw(method, `${API}${path}`, { baseUrl: o.baseUrl, body, headers, auth: o.auth, retry: o.retry });
    const isJson = (res.headers.get("content-type") ?? "").includes("json");
    const data = isJson ? await res.json().catch(() => null) : null;
    if (!res.ok) {
      const message = (data && (data.message || data.error)) || `Erreur ${res.status}`;
      throw new ApiError(res.status, String(message));
    }
    return data as T;
  }

  /** Appel brut. Sur 401 en session ouverte : une reconnexion silencieuse, puis un seul nouvel essai. */
  private async raw(
    method: string,
    path: string,
    o: { baseUrl?: string; body?: BodyInit; headers?: Record<string, string>; auth?: boolean; retry?: boolean },
  ): Promise<Response> {
    const base = o.baseUrl ?? this.baseUrl;
    if (!base) throw new ApiError(401, "Non connecté.");
    const attempt = async (): Promise<Response> => {
      const headers: Record<string, string> = { ...o.headers };
      const cookie = this.jar.header();
      if (cookie) headers.Cookie = cookie;
      if (o.auth !== false && method !== "GET" && this.csrf) headers["X-CSRF"] = this.csrf;
      let res: Response;
      try {
        res = await this.doFetch(base + path, { method, headers, body: o.body, redirect: "manual" });
      } catch {
        throw new ApiError(0, "Serveur Sada injoignable.");
      }
      this.jar.store(res);
      return res;
    };
    let res = await attempt();
    if (res.status === 401 && o.auth !== false && o.retry !== false && this.credentials) {
      await this.relogin();
      res = await attempt();
    }
    if (!res.ok && o.auth !== false && path.startsWith(`${API}/live/studio/whip`)) {
      throw new ApiError(res.status, `Sada a refusé la requête WHIP (${res.status}).`);
    }
    return res;
  }

  private relogin(): Promise<void> {
    this.reauth ??= (async () => {
      const creds = this.credentials;
      const mosque = this.mosqueId;
      if (!creds) throw new ApiError(401, "Non connecté.");
      await this.login(creds);
      if (mosque !== null) await this.selectMosque(mosque);
    })().finally(() => {
      this.reauth = null;
    });
    return this.reauth;
  }
}

function normalizeSession(s: SessionInfo): SessionInfo {
  return { ...s, mosques: s.mosques ?? [] };
}
