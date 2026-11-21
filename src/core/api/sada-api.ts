import { ApiError, DeviceRevokedError } from "../errors";
import { t } from "../messages";
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

/** Normalizes the typed address: https by default, http only locally, no path or trailing slash. */
export function normalizeBaseUrl(input: string): string {
  const raw = input.trim();
  if (!raw) throw new ApiError(0, t("api.addressMissing"));
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new ApiError(0, t("api.addressInvalid"));
  }
  const local = /^(localhost|127\.0\.0\.1|\[::1\]|.+\.local)$/.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new ApiError(0, t("api.addressScheme"));
  }
  return url.origin;
}

export interface SadaApiOptions {
  fetch?: typeof fetch;
  /** Maximum duration of a call (ms). */
  timeoutMs?: number;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "A live is already running since 12:05": the time comes from the server when it provides one. */
export function conflictMessage(data: Record<string, unknown> | null): string {
  const since = typeof data?.since === "string" ? new Date(data.since) : null;
  if (since && !Number.isNaN(since.getTime())) {
    return t("api.liveActiveSince", { time: `${pad(since.getHours())}:${pad(since.getMinutes())}` });
  }
  const msg = data && (data.message ?? data.error);
  return typeof msg === "string" && msg ? msg : t("api.liveActive");
}

/** HTTP client of the device. Device identity via the `Authorization` header. Runs in Node as well as in a browser. */
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
      if (!challenge.deviceCode || !challenge.userCode) throw new ApiError(502, t("api.pairingIncomplete"));
      return challenge;
    },
    poll: async (baseUrl, deviceCode) => {
      const base = normalizeBaseUrl(baseUrl);
      const res = await this.raw("POST", `${API}/studio/pair/poll`, {
        base,
        body: JSON.stringify({ device_code: deviceCode }),
        headers: { "Content-Type": "application/json" },
      });
      if (res.status === 429) return { status: "pending" }; // too many requests: simply keep waiting
      const d = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (res.ok && d?.status === "approved" && d.device_id && d.device_secret) {
        const m = (d.mosque ?? {}) as Record<string, unknown>;
        return {
          status: "paired",
          deviceId: String(d.device_id),
          deviceSecret: String(d.device_secret),
          mosque: { name: String(m.name ?? t("api.mosqueDefault")), id: typeof m.id === "number" ? m.id : undefined, slug: typeof m.slug === "string" ? m.slug : undefined },
        } satisfies PairPoll;
      }
      if (res.ok) return { status: "pending" };
      // 404 unknown, 410 expired / already claimed: a new code is needed. 410 "revoked": the device was removed before the end.
      if (res.status === 410 && d?.status === "revoked") return { status: "denied" };
      if (res.status === 404 || res.status === 410) return { status: "expired" };
      throw new ApiError(res.status, String(d?.message ?? d?.error ?? t("api.httpError", { status: res.status })));
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
      if (res.status !== 201 || !location) throw new ApiError(res.status, t("api.whipUnexpected", { status: res.status }));
      return { answer: await res.text(), resource: this.sameOriginPath(location) };
    },
    patchIce: async (resource, fragment) => {
      await this.raw("PATCH", resource, { body: fragment, headers: { "Content-Type": ICE }, device: true });
    },
    close: async (resource) => {
      await this.raw("DELETE", resource, { device: true });
    },
  };

  /** Only a path on the same instance is followed: a foreign Location never receives the device secret. */
  private sameOriginPath(location: string): string {
    const base = this.requireDevice().baseUrl;
    const u = new URL(location, base);
    if (u.origin !== base) throw new ApiError(502, t("api.whipForeign"));
    return u.pathname;
  }

  private requireDevice(): DeviceCredentials {
    if (!this.device) throw new DeviceRevokedError(t("api.notPaired"));
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

  /** Throws ApiError for any error status; 401/403 on a device call = device revoked. */
  private async check(res: Response): Promise<Record<string, unknown> | null> {
    const isJson = (res.headers.get("content-type") ?? "").includes("json");
    const data = isJson ? ((await res.json().catch(() => null)) as Record<string, unknown> | null) : null;
    if (res.ok) return data;
    if (res.status === 409) throw new ApiError(409, conflictMessage(data));
    const message = (data && (data.message || data.error)) || t("api.httpError", { status: res.status });
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
    if (!base) throw new ApiError(0, t("api.addressMissing"));
    let res: Response;
    try {
      res = await this.doFetch(base + path, { method, headers, body: o.body, redirect: "manual", signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      throw new ApiError(0, t("api.unreachable"));
    }
    if (o.device && res.status === 401) {
      // The device secret is rejected (code "invalid" or "revoked"): it is no longer paired.
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

/** A slot as the server describes it: `slot_id`, `type`, `title`, `starts_at`, `ends_at` (ISO UTC). */
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

/** Is the workstation check `id` explicitly bad or good? `undefined` when it has not run (never a false problem). */
const flag = (checks: HealthCheck[], id: string): boolean | undefined => checks.find((c) => c.id === id)?.ok;

/** Heartbeat body as the contract describes it (docs/studio-devices.md). */
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
  // Before the first workstation check (none reported), camera and microphone are unknown: we do not claim them absent.
  const known = checks.length > 0 ? { camera: r.camera, microphone: r.micro } : {};
  return { state, version: r.version, ...known, bitrate_kbps: r.bitrate, health };
}

/** Lenient: a partial response must never break the heartbeat loop. */
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
  // The current slot, the next one, then the five after: a single sorted list, no duplicates.
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
