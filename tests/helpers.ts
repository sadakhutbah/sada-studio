import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

export interface MockSada {
  url: string;
  requests: Recorded[];
  /** Les n prochains appels WHIP répondent 401 (session expirée). */
  expireSessionOnce(): void;
  /** Statut forcé pour l'offre WHIP (ex. 409). */
  whipStatus: number | null;
  close(): Promise<void>;
}

/** Faux serveur Sada : login à défi anti-rejeu, choix de mosquée, trois routes WHIP. */
export async function startMockSada(): Promise<MockSada> {
  const requests: Recorded[] = [];
  let sessions = 0;
  let valid = new Set<string>();
  let expire = false;
  const mock: MockSada = {
    url: "",
    requests,
    whipStatus: null,
    expireSessionOnce: () => {
      expire = true;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };

  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString();
    const url = req.url ?? "";
    requests.push({ method: req.method ?? "", url, headers: req.headers, body });
    const json = (status: number, data: unknown, extra: Record<string, string | string[]> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...extra });
      res.end(JSON.stringify(data));
    };
    const cookie = (req.headers.cookie ?? "").split("; ").find((c) => c.startsWith("sada_session="))?.split("=")[1] ?? "";
    const signedIn = valid.has(cookie);

    if (url === "/api/v1/login-challenge") return json(200, { pre: "pre123" }, { "set-cookie": "sada_pre=pre123; Path=/; HttpOnly" });
    if (url === "/api/v1/login" && req.method === "POST") {
      const f = new URLSearchParams(body);
      if (f.get("password") !== "secret" || f.get("pre") !== "pre123") return json(401, { error: "identifiants" });
      const token = `tok${++sessions}`;
      valid.add(token);
      return json(
        200,
        {
          user: { id: 7, name: "Imam Test", role: "admin", role_label: "Administrateur", permissions: ["live"] },
          mosque: null,
          mosques: [
            { id: 1, slug: "alpha", name: "Mosquée Alpha", access: "member" },
            { id: 2, slug: "beta", name: "Mosquée Beta", access: "member" },
          ],
          csrf: `csrf-${token}`,
        },
        { "set-cookie": `sada_session=${token}; Path=/; HttpOnly` },
      );
    }
    if (!signedIn || (expire && url.includes("/whip"))) {
      expire = false;
      valid = new Set();
      return json(401, { error: "connexion requise" });
    }
    if (url === "/api/v1/mosques/select") {
      const id = JSON.parse(body).mosque_id;
      return json(200, {
        user: { id: 7, name: "Imam Test", role: "admin", role_label: "Administrateur", permissions: ["live"] },
        mosque: { id, slug: "alpha", name: "Mosquée Alpha" },
        mosques: [],
        csrf: `csrf-${cookie}`,
      });
    }
    if (url === "/api/v1/live/studio/whip" && req.method === "POST") {
      if (mock.whipStatus) return json(mock.whipStatus, { error: "input is not push" });
      res.writeHead(201, { "content-type": "application/sdp", location: "/api/v1/live/studio/whip/sess-1" });
      return res.end("v=0\r\nanswer\r\n");
    }
    if (url === "/api/v1/live/studio/whip/sess-1") {
      res.writeHead(req.method === "DELETE" ? 200 : 204);
      return res.end();
    }
    json(404, { error: "not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  mock.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return mock;
}

/** Faux RTCPeerConnection : suffisant pour dérouler une négociation WHIP. */
export class FakePeer extends EventTarget {
  connectionState: RTCPeerConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "complete";
  localDescription: { type: string; sdp: string } | null = null;
  remote: { type: string; sdp: string } | null = null;
  closed = false;
  onicecandidate: ((e: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  bytes = 0;
  /** Faux comportement : « connected » juste après la réponse. */
  autoConnect = true;

  addTransceiver() {}
  getSenders() {
    return [];
  }
  async createOffer() {
    return { type: "offer", sdp: "v=0\r\noffer\r\n" };
  }
  async setLocalDescription(d: { type: string; sdp: string }) {
    this.localDescription = d;
  }
  async setRemoteDescription(d: { type: string; sdp: string }) {
    this.remote = d;
    if (this.autoConnect) queueMicrotask(() => this.setState("connected"));
  }
  async getStats() {
    const m = new Map<string, Record<string, unknown>>();
    m.set("a", { type: "outbound-rtp", kind: "video", bytesSent: this.bytes, framesPerSecond: 30 });
    m.set("b", { type: "candidate-pair", state: "succeeded", currentRoundTripTime: 0.025 });
    return m;
  }
  close() {
    this.closed = true;
  }
  setState(s: RTCPeerConnectionState) {
    this.connectionState = s;
    this.onconnectionstatechange?.();
    this.dispatchEvent(new Event("connectionstatechange"));
  }
}

export const fakeStream = () => ({ getTracks: () => [{ kind: "video" }, { kind: "audio" }] }) as unknown as MediaStream;
