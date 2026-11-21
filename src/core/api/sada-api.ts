import { ApiError, DeviceRevokedError } from "../errors";
import type { WhipSignaling } from "../transport/whip";
import type {
  CurrentLive,
  DeviceCredentials,
  HealthCheck,
  HeartbeatReply,
  HeartbeatReport,
  PairingApi,
  PairingChallenge,
  PairPoll,
  RotatedCredentials,
  Slot,
  StreamKind,
  StreamMeta,
  StudioApi,
} from "./types";

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

export interface SadaApiOptions {
  fetch?: typeof fetch;
  /** Délai maximal d'un appel (ms). */
  timeoutMs?: number;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** « Un direct est déjà en cours depuis 12:05 » : l'heure vient du serveur quand il la donne. */
export function conflictMessage(data: Record<string, unknown> | null): string {
  const since = typeof data?.since === "string" ? new Date(data.since) : null;
  if (since && !Number.isNaN(since.getTime())) {
    return `Un direct est déjà en cours depuis ${pad(since.getHours())}:${pad(since.getMinutes())}.`;
  }
  const msg = data && (data.message ?? data.error);
  return typeof msg === "string" && msg ? msg : "Un direct est déjà en cours.";
}

/** Client HTTP du boîtier. Identité de l'appareil par `Authorization: Bearer`. Tourne dans Node comme dans un navigateur. */
export class SadaHttpApi implements StudioApi {
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;
  private device: DeviceCredentials | null = null;

  constructor(options: SadaApiOptions = {}) {
    this.doFetch = options.fetch ?? ((...a) => fetch(...a));
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  useDevice(device: DeviceCredentials | null): void {
    this.device = device;
  }

  readonly pairing: PairingApi = {
    start: async (baseUrl, machineName) => {
      const base = normalizeBaseUrl(baseUrl);
      const name = (machineName ?? "").trim().slice(0, 60);
      const d = await this.json<Record<string, unknown>>("POST", `${API}/studio/pair/start`, { base, json: name ? { name } : {} });
      const challenge: PairingChallenge = {
        deviceCode: String(d.device_code ?? ""),
        userCode: String(d.user_code ?? ""),
        expiresInS: Number(d.expires_in) || 600,
        intervalS: Math.max(2, Number(d.interval) || 5),
      };
      if (!challenge.deviceCode || !challenge.userCode) throw new ApiError(502, "Réponse d'appairage incomplète.");
      return challenge;
    },
    poll: async (baseUrl, deviceCode) => {
      const base = normalizeBaseUrl(baseUrl);
      const res = await this.raw("POST", `${API}/studio/pair/poll`, {
        base,
        body: JSON.stringify({ device_code: deviceCode }),
        headers: { "Content-Type": "application/json" },
      });
      if (res.status === 429) return { status: "pending" }; // trop de demandes : on attend simplement
      const d = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (res.ok && d?.status === "approved" && d.device_id && d.device_secret) {
        const m = (d.mosque ?? {}) as Record<string, unknown>;
        return {
          status: "paired",
          deviceId: String(d.device_id),
          deviceSecret: String(d.device_secret),
          mosque: { name: String(m.name ?? "Mosquée"), id: typeof m.id === "number" ? m.id : undefined, slug: typeof m.slug === "string" ? m.slug : undefined },
        } satisfies PairPoll;
      }
      if (res.ok) return { status: "pending" };
      // 404 inconnu, 410 expiré / déjà réclamé : il faut un nouveau code. 410 « revoked » : l'appareil a été retiré avant la fin.
      if (res.status === 410 && d?.status === "revoked") return { status: "denied" };
      if (res.status === 404 || res.status === 410) return { status: "expired" };
      throw new ApiError(res.status, String(d?.message ?? d?.error ?? `Erreur ${res.status}`));
    },
  };

  async heartbeat(report: HeartbeatReport): Promise<HeartbeatReply> {
    const d = await this.json<Record<string, unknown>>("POST", `${API}/studio/heartbeat`, { json: toWireReport(report), device: true });
    return normalizeReply(d);
  }

  async startLive(meta: StreamMeta): Promise<void> {
    await this.json("POST", `${API}/studio/live/start`, { json: meta, device: true });
  }

  async stopLive(): Promise<void> {
    await this.json("POST", `${API}/studio/live/stop`, { json: {}, device: true });
  }

  async unpair(): Promise<void> {
    await this.json("POST", `${API}/studio/unpair`, { json: {}, device: true });
  }

  readonly whip: WhipSignaling = {
    offer: async (sdp) => {
      const res = await this.raw("POST", `${API}/live/studio/whip`, { body: sdp, headers: { "Content-Type": SDP }, device: true });
      await this.check(res);
      const location = res.headers.get("location");
      if (res.status !== 201 || !location) throw new ApiError(res.status, `Réponse WHIP inattendue (${res.status}).`);
      return { answer: await res.text(), resource: this.sameOriginPath(location) };
    },
    patchIce: async (resource, fragment) => {
      await this.raw("PATCH", resource, { body: fragment, headers: { "Content-Type": ICE }, device: true });
    },
    close: async (resource) => {
      await this.raw("DELETE", resource, { device: true });
    },
  };

  /** Seul un chemin de la même instance est suivi : un Location extérieur ne reçoit jamais le secret de l'appareil. */
  private sameOriginPath(location: string): string {
    const base = this.requireDevice().baseUrl;
    const u = new URL(location, base);
    if (u.origin !== base) throw new ApiError(502, "Ressource WHIP hors de l'instance.");
    return u.pathname;
  }

  private requireDevice(): DeviceCredentials {
    if (!this.device) throw new DeviceRevokedError("Appareil non appairé.");
    return this.device;
  }

  private async json<T>(
    method: string,
    path: string,
    o: { base?: string; json?: unknown; device?: boolean },
  ): Promise<T> {
    const res = await this.raw(method, path, {
      base: o.base,
      device: o.device,
      body: o.json === undefined ? undefined : JSON.stringify(o.json),
      headers: o.json === undefined ? {} : { "Content-Type": "application/json" },
    });
    const data = await this.check(res);
    return data as T;
  }

  /** Lève ApiError pour tout statut d'erreur ; 401/403 d'un appel appareil = appareil révoqué. */
  private async check(res: Response): Promise<Record<string, unknown> | null> {
    const isJson = (res.headers.get("content-type") ?? "").includes("json");
    const data = isJson ? ((await res.json().catch(() => null)) as Record<string, unknown> | null) : null;
    if (res.ok) return data;
    if (res.status === 409) throw new ApiError(409, conflictMessage(data));
    const message = (data && (data.message || data.error)) || `Erreur ${res.status}`;
    throw new ApiError(res.status, String(message));
  }

  private async raw(
    method: string,
    path: string,
    o: { base?: string; body?: BodyInit; headers?: Record<string, string>; device?: boolean },
  ): Promise<Response> {
    const headers: Record<string, string> = { Accept: "application/json", ...o.headers };
    let base = o.base ?? "";
    if (o.device) {
      const d = this.requireDevice();
      base = d.baseUrl;
      headers.Authorization = `Bearer ${d.deviceSecret}`;
    }
    if (!base) throw new ApiError(0, "Adresse de l'instance manquante.");
    let res: Response;
    try {
      res = await this.doFetch(base + path, { method, headers, body: o.body, redirect: "manual", signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      throw new ApiError(0, "Serveur Sada injoignable.");
    }
    if (o.device && res.status === 401) {
      // Le secret de l'appareil est refusé (code « invalid » ou « revoked ») : il n'est plus appairé.
      throw new DeviceRevokedError();
    }
    return res;
  }
}

function toMs(v: unknown): number | null {
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

const kind = (v: unknown): StreamKind => (v === "dars" ? "dars" : v === "conference" ? "conference" : "khutba");

/** Un créneau tel que le serveur le décrit : `slot_id`, `type`, `title`, `starts_at`, `ends_at` (ISO UTC). */
function normalizeSlot(raw: unknown): Slot | null {
  const s = raw as Record<string, unknown> | null;
  if (!s) return null;
  const startsAt = toMs(s.starts_at);
  if (startsAt === null) return null;
  return {
    id: s.slot_id === undefined || s.slot_id === null ? undefined : String(s.slot_id),
    type: kind(s.type),
    title: String(s.title ?? ""),
    startsAt,
    endsAt: toMs(s.ends_at),
  };
}

/** Le contrôle `id` du poste est-il explicitement mauvais ou bon ? `undefined` quand il n'a pas été fait (jamais un faux problème). */
const flag = (checks: HealthCheck[], id: string): boolean | undefined => checks.find((c) => c.id === id)?.ok;

/** Corps du battement tel que le contrat le décrit (docs/studio-devices.md). */
export function toWireReport(r: HeartbeatReport): Record<string, unknown> {
  const checks = r.health.checks;
  const health: Record<string, boolean> = {};
  const auto = flag(checks, "windows_autologon");
  const hours = flag(checks, "windows_update_active_hours");
  const sleep = flag(checks, "sleep");
  if (auto !== undefined) health.auto_login = auto;
  if (hours !== undefined) health.update_hours = hours;
  if (sleep !== undefined) health.sleep_disabled = sleep;
  const state = r.state === "live" || r.state === "connecting" || r.state === "reconnecting" ? "live" : r.state === "error" ? "error" : "standby";
  return { state, version: r.version, camera: r.camera, microphone: r.micro, bitrate_kbps: r.bitrate, health };
}

/** Tolérant : une réponse partielle ne doit jamais faire tomber la boucle de battement. */
export function normalizeReply(d: Record<string, unknown>): HeartbeatReply {
  const c = d.current as Record<string, unknown> | null | undefined;
  const current: CurrentLive | null = c
    ? {
        type: kind(c.type),
        title: String(c.title ?? ""),
        source: c.source === "manual" ? "manual" : "schedule",
        slotId: c.slot_id === undefined || c.slot_id === null ? undefined : String(c.slot_id),
      }
    : null;
  // Le créneau en cours, le suivant, puis les cinq suivants : une seule liste triée, sans doublon.
  const raw = [c?.source === "schedule" ? c : null, d.next, ...(Array.isArray(d.slots) ? d.slots : [])];
  const schedule: Slot[] = [];
  for (const r of raw) {
    const slot = normalizeSlot(r);
    if (slot && !schedule.some((x) => (x.id && slot.id ? x.id === slot.id : x.startsAt === slot.startsAt && x.title === slot.title))) schedule.push(slot);
  }
  schedule.sort((a, b) => a.startsAt - b.startsAt);
  const cfg = { ...(d.config as Record<string, unknown> | undefined) };
  if (cfg.heartbeat_interval === undefined) cfg.heartbeat_interval = cfg.heartbeat_interval_s;
  const cr = d.credentials as Record<string, unknown> | null | undefined;
  const credentials: RotatedCredentials | undefined =
    cr && typeof cr.device_secret === "string" && cr.device_secret ? { deviceId: String(cr.device_id ?? ""), deviceSecret: cr.device_secret } : undefined;
  const reply: HeartbeatReply = { config: cfg, schedule, command: d.command === "live" ? "live" : "idle", current };
  if (credentials) reply.credentials = credentials;
  return reply;
}
