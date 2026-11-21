// Faux serveur Sada pour essayer le boîtier sans instance : `npm run mock`, puis, dans l'application, adresse
// http://127.0.0.1:8787. Le code d'appairage s'affiche ici ; il est accepté seul au bout de APPROVE_AFTER_MS (8 s par défaut),
// ou à la main : curl -X POST 'http://127.0.0.1:8787/__mock/approve'.
// Pilotage à la main : /__mock/live?type=khutba&title=…, /__mock/idle, /__mock/revoke, /__mock/conflict?on=1.
// Le même moteur sert aux tests (tests/helpers.ts) : contrat provisoire de la branche feat/studio-devices.
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const MOSQUE = { id: 1, slug: "alpha", name: "Mosquée Alpha" };

/** Prochain vendredi 13 h 15 (heure locale), au moins une heure devant. */
export function nextFriday(now = Date.now()) {
  const d = new Date(now);
  d.setHours(13, 15, 0, 0);
  while (d.getDay() !== 5 || d.getTime() < now + 3600_000) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export async function createMockSada({ port = 0, approveAfterMs = null, codeTtlS = 600, log = false } = {}) {
  const requests = [];
  let seq = 0;
  const pairings = new Map(); // device_code -> { userCode, expiresAt, approved }
  const devices = new Map(); // secret -> { id, revoked }
  const mock = {
    url: "",
    requests,
    schedule: [],
    command: "idle",
    current: null,
    /** Statut forcé de l'offre WHIP (ex. 409). */
    whipStatus: null,
    /** Les n prochains battements répondent ce statut (ex. 500). */
    failHeartbeats: 0,
    heartbeatInterval: 30,
    since: new Date(Date.now() - 12 * 60_000).toISOString(),
    heartbeats: () => requests.filter((r) => r.url === "/api/v1/studio/heartbeat").map((r) => JSON.parse(r.body || "{}")),
    /** Saisie du code dans la console : sans argument, le dernier code émis. */
    approve(userCode) {
      for (const [, p] of pairings) if (!userCode || p.userCode === userCode) p.approved = true;
    },
    revokeAll() {
      for (const d of devices.values()) d.revoked = true;
    },
    setLive(current) {
      mock.command = "live";
      mock.current = current;
    },
    setIdle() {
      mock.command = "idle";
      mock.current = null;
    },
    close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(() => r()))),
  };

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
    const secret = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
    const device = devices.get(secret);
    const authed = device && !device.revoked;

    // Aides pour l'essayeur (pas dans le contrat).
    if (path === "/__mock/approve") return mock.approve(url.searchParams.get("code") ?? undefined), json(200, { ok: true });
    if (path === "/__mock/revoke") return mock.revokeAll(), json(200, { ok: true });
    if (path === "/__mock/idle") return mock.setIdle(), json(200, { ok: true });
    if (path === "/__mock/live") {
      mock.setLive({ type: url.searchParams.get("type") ?? "khutba", title: url.searchParams.get("title") ?? "Direct", source: "schedule" });
      return json(200, { ok: true });
    }
    if (path === "/__mock/conflict") return (mock.whipStatus = url.searchParams.get("on") === "0" ? null : 409), json(200, { ok: true });

    if (path === "/api/v1/studio/pair/start" && req.method === "POST") {
      const n = ++seq;
      const device_code = `dc-${n}`;
      const user_code = n === 1 ? "K7QM-4TZ2" : `K7Q${n}-4TZ2`;
      pairings.set(device_code, { userCode: user_code, expiresAt: Date.now() + codeTtlS * 1000, approved: false });
      if (log) console.log(`Code d'appairage : ${user_code}`);
      if (approveAfterMs !== null) setTimeout(() => (pairings.get(device_code).approved = true), approveAfterMs);
      return json(200, { device_code, user_code, expires_in: codeTtlS, interval: 2 });
    }
    if (path === "/api/v1/studio/pair/poll" && req.method === "POST") {
      const p = pairings.get(JSON.parse(body || "{}").device_code);
      if (!p) return json(404, { error: "code inconnu" });
      if (Date.now() > p.expiresAt) return json(410, { error: "code expiré" });
      if (!p.approved) return json(200, { status: "pending" });
      const device_secret = `secret-${++seq}`;
      const device_id = `dev-${seq}`;
      devices.set(device_secret, { id: device_id, revoked: false });
      pairings.delete(JSON.parse(body).device_code);
      return json(200, { device_id, device_secret, mosque: MOSQUE });
    }
    if (path.startsWith("/api/v1/studio/") || path.startsWith("/api/v1/live/studio/")) {
      if (!authed) return json(401, { error: "appareil inconnu ou révoqué" });
    }
    if (path === "/api/v1/studio/heartbeat" && req.method === "POST") {
      if (mock.failHeartbeats > 0) return mock.failHeartbeats--, json(500, { error: "panne" });
      return json(200, {
        config: { heartbeat_interval: mock.heartbeatInterval },
        schedule: mock.schedule,
        command: mock.command,
        current: mock.current,
      });
    }
    if (path === "/api/v1/studio/live/start" && req.method === "POST") {
      if (mock.current) return json(409, { message: "Un direct est déjà en cours", since: mock.since });
      const { type, title } = JSON.parse(body || "{}");
      mock.setLive({ type, title, source: "manual" });
      return json(200, { ok: true });
    }
    if (path === "/api/v1/studio/live/stop" && req.method === "POST") {
      mock.setIdle();
      return json(200, { ok: true });
    }
    if (path === "/api/v1/live/studio/whip" && req.method === "POST") {
      if (mock.whipStatus) return json(mock.whipStatus, { message: "Un direct est déjà en cours", since: mock.since });
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
    { id: "s1", type: "khutba", title: "Khutba du vendredi", starts_at: new Date(t).toISOString(), ends_at: new Date(t + 45 * 60_000).toISOString() },
    { id: "s2", type: "dars", title: "Dars après Isha", starts_at: new Date(t + 6 * 3600_000).toISOString(), ends_at: new Date(t + 7 * 3600_000).toISOString() },
  ];
  console.log(`Faux Sada sur ${mock.url}`);
}
