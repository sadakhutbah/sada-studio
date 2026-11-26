import { createHash, timingSafeEqual } from "node:crypto";
import { CONTROL_ACTIONS, isControlAction, parseControlRequest, type ControlRequest, type ControlResult } from "../core/control/actions";

/** Request of the local control API as the server hands it over (no Electron here: it is tested on its own). */
export interface ControlHttpRequest {
  method: string;
  /** Path and query, as received (`/v1/actions/mic.toggle?scene=x`). */
  url: string;
  headers: Record<string, string | string[] | undefined>;
  remoteAddress: string | undefined;
  body: string;
}

export interface ControlHttpResponse {
  status: number;
  headers?: Record<string, string>;
  body: Record<string, unknown>;
}

export interface ControlHttpDeps {
  token(): string;
  /** Port the server listens on: a request must have been addressed to it. */
  port(): number;
  execute(request: ControlRequest): Promise<ControlResult>;
  now?(): number;
}

export const API_PREFIX = "/v1";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** Failed authentications tolerated per window, then the API answers 429 until the window ends. */
const MAX_FAILURES = 20;
const FAILURE_WINDOW_MS = 60_000;

/** Constant-time comparison of two secrets of any length (both are hashed to a fixed size first). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export const isLoopbackAddress = (addr: string | undefined): boolean =>
  addr !== undefined && (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr) || addr === "::1" || /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i.test(addr));

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** `host[:port]` of a Host header: lower-cased host (IPv6 in brackets) and the port, or null when malformed. */
function splitHost(value: string): { host: string; port: number | null } | null {
  const m = /^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(value.trim());
  return m ? { host: m[1]!.toLowerCase(), port: m[2] ? Number(m[2]) : null } : null;
}

/** An Origin of this computer (`http://localhost:3000`...). `null`, other hosts and other schemes are refused. */
export function isLocalOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return (u.protocol === "http:" || u.protocol === "https:") && LOCAL_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

const reply = (status: number, body: Record<string, unknown>, headers?: Record<string, string>): ControlHttpResponse => ({ status, body, ...(headers ? { headers } : {}) });
const fail = (status: number, code: string, message: string, headers?: Record<string, string>) => reply(status, { ok: false, code, message }, headers);

const FAILURE_STATUS: Record<string, number> = { ui_unavailable: 503, timeout: 504, failed: 500 };

/**
 * The local control API. Order of the checks: the peer is this computer, the request was addressed to a local name
 * (no DNS rebinding), the page that sent it (if any) is local and not a cross-site request, then the token, compared
 * in constant time. Nothing is answered about the actions before all of that passes.
 */
export class ControlHttpHandler {
  private failures: number[] = [];

  constructor(private readonly deps: ControlHttpDeps) {}

  async handle(req: ControlHttpRequest): Promise<ControlHttpResponse> {
    const now = this.deps.now?.() ?? Date.now();
    if (!isLoopbackAddress(req.remoteAddress)) return fail(403, "not_local", "Only this computer may use this API.");

    const host = splitHost(first(req.headers.host) ?? "");
    if (!host || !LOCAL_HOSTS.has(host.host) || (host.port !== null && host.port !== this.deps.port())) {
      return fail(403, "bad_host", "Address the API as 127.0.0.1 or localhost.");
    }
    const origin = first(req.headers.origin);
    if (origin !== undefined && !isLocalOrigin(origin)) return fail(403, "origin_refused", "This origin is not allowed.");
    const site = first(req.headers["sec-fetch-site"]);
    if (site !== undefined && site !== "none" && site !== "same-origin") return fail(403, "origin_refused", "Cross-site requests are not allowed.");

    this.failures = this.failures.filter((t) => now - t < FAILURE_WINDOW_MS);
    if (this.failures.length >= MAX_FAILURES) {
      const retry = Math.max(1, Math.ceil((FAILURE_WINDOW_MS - (now - this.failures[0]!)) / 1000));
      return fail(429, "too_many_attempts", "Too many failed attempts.", { "Retry-After": String(retry) });
    }

    let url: URL;
    try {
      url = new URL(req.url, "http://127.0.0.1");
    } catch {
      return fail(400, "bad_request", "Malformed address.");
    }
    if (!this.authorized(req, url)) {
      this.failures.push(now);
      return fail(401, "unauthorized", "Missing or wrong token.", { "WWW-Authenticate": "Bearer" });
    }

    return this.route(req, url);
  }

  private authorized(req: ControlHttpRequest, url: URL): boolean {
    const bearer = /^Bearer\s+(\S+)$/i.exec(first(req.headers.authorization) ?? "");
    const given = bearer?.[1] ?? first(req.headers["x-sada-token"]) ?? url.searchParams.get("token") ?? "";
    // Compared even when empty: the work done does not depend on what was sent.
    return safeEqual(given, this.deps.token()) && given !== "";
  }

  private async route(req: ControlHttpRequest, url: URL): Promise<ControlHttpResponse> {
    const method = req.method.toUpperCase();
    if (url.pathname === `${API_PREFIX}/actions`) {
      if (method !== "GET") return fail(405, "method_not_allowed", "Use GET.", { Allow: "GET" });
      return reply(200, { ok: true, actions: [...CONTROL_ACTIONS] });
    }
    const m = new RegExp(`^${API_PREFIX}/actions/([\\w.-]{1,40})$`).exec(url.pathname);
    if (!m) return fail(404, "not_found", "Unknown address.");
    if (method !== "GET" && method !== "POST") return fail(405, "method_not_allowed", "Use POST (or GET).", { Allow: "GET, POST" });
    const action = m[1]!;
    if (!isControlAction(action)) return fail(404, "unknown_action", "Unknown action.");

    let scene: unknown = url.searchParams.get("scene") ?? undefined;
    if (req.body.trim() !== "") {
      try {
        const body = JSON.parse(req.body) as unknown;
        if (body && typeof body === "object" && "scene" in body) scene = (body as { scene: unknown }).scene;
      } catch {
        return fail(400, "bad_json", "The body is not valid JSON.");
      }
    }
    const request = parseControlRequest(action, scene);
    if (!request) return fail(400, "bad_scene", "scene.set needs a valid scene identifier.");

    const result = await this.deps.execute(request);
    if (result.ok) return reply(200, { ...result });
    return reply(FAILURE_STATUS[result.code ?? ""] ?? 409, { ...result });
  }
}
