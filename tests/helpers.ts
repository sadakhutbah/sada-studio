import type { DeviceCredentials, HeartbeatReply, HeartbeatReport, PairPoll, PairingChallenge, StreamMeta, StudioApi } from "../src/core/api/types";
import { ApiError, DeviceRevokedError } from "../src/core/errors";
import type { DeviceStore, PersistStore, Persisted } from "../src/core/kiosk/supervisor";
import { createMockSada, type MockSada } from "../scripts/mock-sada.mjs";

/** Faux serveur Sada : le même moteur que `npm run mock` (scripts/mock-sada.mjs). */
export const startMockSada = (): Promise<MockSada> => createMockSada();
export type { MockSada };

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

export const MOSQUE = { id: 1, slug: "alpha", name: "Mosquée Alpha" };

export const IDLE_REPLY: HeartbeatReply = { config: {}, schedule: [], command: "idle", current: null };

/** API en mémoire : réponses scriptées, appels enregistrés. Pour les tests de superviseur sans réseau. */
export class FakeApi implements StudioApi {
  reply: HeartbeatReply = IDLE_REPLY;
  beats: HeartbeatReport[] = [];
  beatError: Error | null = null;
  startError: Error | null = null;
  stopError: Error | null = null;
  startCalls: StreamMeta[] = [];
  stopCalls = 0;
  device: DeviceCredentials | null = null;
  pollQueue: PairPoll[] = [];
  starts = 0;
  readonly whip = { offer: async () => ({ answer: "", resource: "" }), patchIce: async () => undefined, close: async () => undefined };
  readonly pairing = {
    start: async (): Promise<PairingChallenge> => {
      this.starts++;
      return { deviceCode: `dc${this.starts}`, userCode: `CODE-${this.starts}`, expiresInS: 60, intervalS: 2 };
    },
    poll: async (): Promise<PairPoll> => this.pollQueue.shift() ?? { status: "pending" },
  };
  useDevice(d: DeviceCredentials | null) {
    this.device = d;
  }
  async heartbeat(r: HeartbeatReport) {
    this.beats.push(r);
    if (this.beatError) throw this.beatError;
    return this.reply;
  }
  async startLive(m: StreamMeta) {
    if (this.startError) throw this.startError;
    this.startCalls.push(m);
  }
  async stopLive() {
    if (this.stopError) throw this.stopError;
    this.stopCalls++;
  }
}

export const revoked = () => new DeviceRevokedError();
export const network = () => new ApiError(0, "Serveur Sada injoignable.");

export class MemoryDevices implements DeviceStore {
  saved: DeviceCredentials | null = null;
  persistent = true;
  load() {
    return this.saved;
  }
  save(d: DeviceCredentials) {
    this.saved = d;
  }
  clear() {
    this.saved = null;
  }
}

export class MemoryPersist implements PersistStore {
  data: Persisted = { wasLive: false, suppressed: [] };
  load() {
    return this.data;
  }
  save(p: Persisted) {
    this.data = p;
  }
}
