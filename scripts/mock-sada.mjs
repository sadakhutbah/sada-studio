// Faux serveur Sada, reflet du contrat `docs/studio-devices.md` du dépôt sada (source unique) : mêmes routes, mêmes
// corps, mêmes codes (401 invalid/revoked, 404/410 d'appairage, 409 live_active avec `since`, 422 bad_type), même
// logique d'ordre (direct à partir de « début − marge », direct manuel jamais coupé par un créneau, arrêt manuel
// d'un créneau sans redémarrage). `npm run mock`, puis, dans l'application, adresse http://127.0.0.1:8787.
// Le code d'appairage s'affiche ici ; il est accepté seul au bout de APPROVE_AFTER_MS (8 s par défaut), ou à la main :
//   curl -X POST 'http://127.0.0.1:8787/__mock/approve'
// Pilotage à la main (hors contrat) : /__mock/live?type=khutba&title=… , /__mock/idle , /__mock/revoke ,
// /__mock/conflict?on=1 , /__mock/rotate . Le même moteur sert aux tests (tests/helpers.ts).
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const MOSQUE = { name: "Mosquée Alpha", slug: "alpha" };
const TYPES = ["khutba", "dars", "conference"];
const MARGIN_S = 120;

/** Prochain vendredi 13 h 15 (heure locale), au moins une heure devant. */
export function nextFriday(now = Date.now()) {
  const d = new Date(now);
  d.setHours(13, 15, 0, 0);
  while (d.getDay() !== 5 || d.getTime() < now + 3600_000) d.setDate(d.getDate() + 1);
  return d.getTime();
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const newSecret = (id) => `${id}.${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 12)}`;

export async function createMockSada({ port = 0, approveAfterMs = null, codeTtlS = 600, log = false } = {}) {
  const requests = [];
  let seq = 0;
  const pairings = new Map(); // device_code -> { userCode, name, expiresAt, approved, deviceId }
  const devices = new Map(); // id -> { id, secret, prevSecret, name, revoked, spoke, rotate }
  const mock = {
    url: "",
    requests,
    /** Créneaux : { slot_id, type, title, starts_at, ends_at } (ISO UTC). */
    schedule: [],
    /** Direct manuel en cours : { type, title, startedAt, deviceId } ou null. */
    manual: null,
    /** Créneaux arrêtés à la main (pas de redémarrage). */
    stopped: new Set(),
    /** Statut forcé de l'offre WHIP (ex. 409 : un autre publieur). */
    whipStatus: null,
    /** Les n prochains battements répondent ce statut (ex. 500). */
    failHeartbeats: 0,
    heartbeatInterval: 30,
    /** Un autre publieur (OBS…) tient le flux depuis `since`. */
    otherPublisher: false,
    since: new Date(Date.now() - 12 * 60_000).toISOString(),
    /** Horloge du serveur (pour les essais). */
    now: () => Date.now(),
    heartbeats: () => requests.filter((r) => r.url === "/api/v1/studio/heartbeat").map((r) => JSON.parse(r.body || "{}")),
    /** Saisie du code dans la console : sans argument, tous les codes en attente. */
    approve(userCode) {
      for (const [, p] of pairings) if (!userCode || p.userCode === userCode) p.approved = true;
    },
    revokeAll() {
      for (const d of devices.values()) d.revoked = true;
    },
    /** La console demande une rotation : le prochain battement apporte un nouveau secret. */
    rotateAll() {
      for (const d of devices.values()) d.rotate = true;
    },
    get devices() {
      return [...devices.values()];
    },
    /** Direct manuel (comme `live/start`) ou créneau en cours imposé, pour les essais. */
    setLive({ type = "khutba", title = "Direct", source = "manual" } = {}) {
      if (source === "manual") mock.manual = { type, title, startedAt: mock.now(), deviceId: null };
      else {
        const t = mock.now();
        mock.schedule = [{ slot_id: `forced@${t}`, type, title, starts_at: iso(t - 60_000), ends_at: iso(t + 3600_000) }, ...mock.schedule];
      }
    },
    setIdle() {
      mock.manual = null;
      mock.stopped = new Set(order().running.map((s) => s.slot_id));
    },
    get command() {
      return order().command;
    },
    get current() {
      return order().current;
    },
    close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(() => r()))),
  };

  const slotView = (s) => ({ ...s, starts_in_s: Math.round((Date.parse(s.starts_at) - mock.now()) / 1000) });

  /** L'ordre du serveur (studio_plan.decide) : manuel > créneau (de début − marge à la fin) > repos. */
  function order() {
    const now = mock.now();
    const slots = [...mock.schedule].sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at)).filter((s) => Date.parse(s.ends_at) > now);
    const running = slots.filter((s) => Date.parse(s.starts_at) - MARGIN_S * 1000 <= now && !mock.stopped.has(s.slot_id));
    const upcoming = slots.filter((s) => Date.parse(s.starts_at) - MARGIN_S * 1000 > now);
    const next = upcoming[0] ?? null;
    const base = { next: next && slotView(next), slots: upcoming.slice(0, 5).map(slotView), running };
    if (mock.manual) {
      const m = mock.manual;
      return {
        command: "live",
        reason_code: "manual",
        reason: "A live started from the device is in progress.",
        current: { source: "manual", slot_id: null, type: m.type, title: m.title, starts_at: iso(m.startedAt), ends_at: null, starts_in_s: Math.round((m.startedAt - now) / 1000) },
        ...base,
      };
    }
    if (running.length) {
      return { command: "live", reason_code: "slot", reason: "A live is planned: start broadcasting.", current: { source: "schedule", ...slotView(running[0]) }, ...base };
    }
    const wasStopped = slots.some((s) => mock.stopped.has(s.slot_id) && Date.parse(s.starts_at) - MARGIN_S * 1000 <= now);
    return {
      command: "standby",
      reason_code: wasStopped ? "slot_stopped" : "idle",
      reason: wasStopped ? "This live was stopped by hand; it will not restart by itself." : "No live planned for now.",
      current: null,
      ...base,
    };
  }
  const answer = () => {
    const { running: _running, ...o } = order();
    return o;
  };

  const conflict = () => ({
    error: "A live is already running from the mosque's OBS stream key.",
    code: "live_active",
    since: mock.since,
    source: { kind: "obs", label: "", since: Date.parse(mock.since) / 1000 },
  });

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    requests.push({ method: req.method ?? "", url: path, headers: req.headers, body });
    const json = (status, data, extra = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...extra });
      res.end(JSON.stringify(data));
    };
    const parsed = () => {
      try {
        return JSON.parse(body || "{}");
      } catch {
        return {};
      }
    };

    // Aides pour l'essayeur (hors contrat).
    if (path === "/__mock/approve") return mock.approve(url.searchParams.get("code") ?? undefined), json(200, { ok: true });
    if (path === "/__mock/revoke") return mock.revokeAll(), json(200, { ok: true });
    if (path === "/__mock/rotate") return mock.rotateAll(), json(200, { ok: true });
    if (path === "/__mock/idle") return mock.setIdle(), json(200, { ok: true });
    if (path === "/__mock/live") {
      mock.setLive({ type: url.searchParams.get("type") ?? "khutba", title: url.searchParams.get("title") ?? "Direct", source: "manual" });
      return json(200, { ok: true });
    }
    if (path === "/__mock/conflict") return (mock.whipStatus = url.searchParams.get("on") === "0" ? null : 409), json(200, { ok: true });

    // ── Appairage (public) ──
    if (path === "/api/v1/studio/pair/start" && req.method === "POST") {
      const n = ++seq;
      const device_code = `dc-${n}-${Math.random().toString(36).slice(2, 12)}`;
      const user_code = n === 1 ? "K7QM-4TZ2" : `K7Q${n}-4TZ2`;
      const name = String(parsed().name ?? "").trim().slice(0, 60);
      pairings.set(device_code, { userCode: user_code, name, expiresAt: Date.now() + codeTtlS * 1000, approved: false, deviceId: null });
      if (log) console.log(`Code d'appairage : ${user_code}${name ? ` (machine « ${name} »)` : ""}`);
      if (approveAfterMs !== null) setTimeout(() => (pairings.get(device_code).approved = true), approveAfterMs);
      return json(200, { device_code, user_code, expires_in: codeTtlS, interval: 5 });
    }
    if (path === "/api/v1/studio/pair/poll" && req.method === "POST") {
      const p = pairings.get(parsed().device_code);
      if (!p) return json(404, { status: "unknown", message: "Unknown pairing: start again." });
      if (!p.approved) {
        if (Date.now() > p.expiresAt) return json(410, { status: "expired", message: "The code has expired: start the pairing again." });
        return json(200, { status: "pending", interval: 5, expires_in: Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000)) });
      }
      let d = p.deviceId ? devices.get(p.deviceId) : null;
      if (!d) {
        const id = `sdev_${++seq}`;
        d = { id, secret: "", prevSecret: "", name: p.name || "Appareil", revoked: false, spoke: false, rotate: false };
        devices.set(id, d);
        p.deviceId = id;
      }
      if (d.revoked) return json(410, { status: "revoked", message: "This device has been revoked." });
      if (d.spoke) return json(410, { status: "claimed", message: "This pairing was already completed." });
      d.secret = newSecret(d.id); // un secret jamais utilisé (réponse perdue) est remplacé
      return json(200, { status: "approved", device_id: d.id, device_secret: d.secret, name: d.name, mosque: MOSQUE });
    }

    // ── Routes de l'appareil : identifiant porteur ──
    const bearer = /^Bearer (sdev_\d+\.\S+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
    const dev = [...devices.values()].find((d) => d.secret === bearer || (d.prevSecret && d.prevSecret === bearer));
    if (path.startsWith("/api/v1/studio/") || path.startsWith("/api/v1/live/studio/")) {
      if (!dev) return json(401, { error: "device credential unknown", code: "invalid" });
      if (dev.revoked) return json(401, { error: "this device has been revoked by the mosque", code: "revoked" });
      dev.spoke = true;
    }

    if (path === "/api/v1/studio/heartbeat" && req.method === "POST") {
      if (mock.failHeartbeats > 0) return mock.failHeartbeats--, json(500, { error: "panne" });
      const out = {
        server_time: iso(mock.now()),
        ...answer(),
        config: {
          name: dev.name,
          mosque: { ...MOSQUE, timezone: "Europe/Paris" },
          heartbeat_interval_s: mock.heartbeatInterval,
          start_margin_s: MARGIN_S,
          token_path: "/api/v1/live/studio/token",
          whip_path: "/api/v1/live/studio/whip",
        },
      };
      if (dev.rotate) {
        dev.prevSecret = dev.secret;
        dev.secret = newSecret(dev.id);
        dev.rotate = false;
        out.credentials = { device_id: dev.id, device_secret: dev.secret };
      } else if (dev.prevSecret && bearer === dev.secret) dev.prevSecret = ""; // le nouveau secret est adopté
      return json(200, out);
    }
    if (path === "/api/v1/studio/live/start" && req.method === "POST") {
      const { type, title } = parsed();
      if (!TYPES.includes(String(type ?? "").toLowerCase())) return json(422, { error: "Unknown type: choose khutba, dars or conference.", code: "bad_type" });
      if (mock.otherPublisher || (mock.manual && mock.manual.deviceId !== dev.id)) return json(409, conflict());
      const t = String(title ?? "").trim().slice(0, 200);
      if (mock.manual) Object.assign(mock.manual, { type, title: t });
      else mock.manual = { type, title: t, startedAt: mock.now(), deviceId: dev.id };
      return json(200, answer());
    }
    if (path === "/api/v1/studio/live/stop" && req.method === "POST") {
      const stopped = [];
      if (mock.manual) {
        mock.manual = null;
        stopped.push("manual");
      }
      const running = order().running;
      if (running.length) {
        for (const s of running) mock.stopped.add(s.slot_id);
        stopped.push("slot");
      }
      return json(200, { stopped, ...answer() });
    }
    if (path === "/api/v1/studio/live/announce" && req.method === "POST") {
      const { type, title } = parsed();
      if (!TYPES.includes(String(type ?? "").toLowerCase())) return json(422, { error: "Unknown type: choose khutba, dars or conference.", code: "bad_type" });
      if (answer().command !== "live") return json(409, { error: "No live is in progress to announce.", code: "no_live" });
      if (mock.manual) Object.assign(mock.manual, { type, title });
      return json(200, answer());
    }
    if (path === "/api/v1/studio/unpair" && req.method === "POST") {
      dev.revoked = true;
      if (mock.manual?.deviceId === dev.id) mock.manual = null;
      return json(200, { unpaired: true, stream_cut: false });
    }
    if (path === "/api/v1/live/studio/whip" && req.method === "POST") {
      if (mock.whipStatus === 409 || mock.otherPublisher) return json(409, conflict());
      if (mock.whipStatus) return json(mock.whipStatus, { error: "refus", code: "refused" });
      if (answer().command !== "live") return json(409, { error: "This device is not ordered to broadcast.", code: "not_ordered" });
      res.writeHead(201, { "content-type": "application/sdp", location: "/api/v1/live/studio/whip/sess-1" });
      return res.end("v=0\r\nanswer\r\n");
    }
    if (path === "/api/v1/live/studio/whip/sess-1") {
      res.writeHead(req.method === "DELETE" ? 200 : 204);
      return res.end();
    }
    json(404, { error: "not found" });
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  mock.url = `http://127.0.0.1:${server.address().port}`;
  return mock;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const mock = await createMockSada({ port: Number(process.env.PORT ?? 8787), approveAfterMs: Number(process.env.APPROVE_AFTER_MS ?? 8000), log: true });
  const t = nextFriday();
  mock.schedule = [
    { slot_id: "jumua-0@khutba", type: "khutba", title: "Khutba du vendredi", starts_at: iso(t), ends_at: iso(t + 45 * 60_000) },
    { slot_id: "dars-1@isha", type: "dars", title: "Dars après Isha", starts_at: iso(t + 6 * 3600_000), ends_at: iso(t + 7 * 3600_000) },
  ];
  console.log(`Faux Sada sur ${mock.url}`);
}
