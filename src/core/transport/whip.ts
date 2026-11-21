import { ApiError, FatalError } from "../errors";
import type { ConnectOptions, Transport, TransportStats } from "./types";

/** Signalisation WHIP (RFC 9725) : trois appels. L'implémentation HTTP vit dans `api/sada-api.ts`. */
export interface WhipSignaling {
  /** Envoie l'offre SDP ; rend la réponse SDP et l'identifiant de la ressource (Location). */
  offer(sdp: string): Promise<{ answer: string; resource: string }>;
  /** Candidats ICE tardifs (trickle), fragment `application/trickle-ice-sdpfrag`. */
  patchIce(resource: string, fragment: string): Promise<void>;
  close(resource: string): Promise<void>;
}

export interface WhipOptions {
  signaling: WhipSignaling;
  createPeer?: () => RTCPeerConnection;
  /** Attente maximale de la collecte ICE avant d'envoyer l'offre. */
  gatherTimeoutMs?: number;
  connectTimeoutMs?: number;
  /** Délai de grâce avant de déclarer perdue une liaison « disconnected » (elle revient souvent seule). */
  disconnectGraceMs?: number;
}

/** Transport WHIP : une RTCPeerConnection envoyante, négociée en un aller-retour HTTP. */
export class WhipTransport implements Transport {
  readonly kind = "whip";
  private pc: RTCPeerConnection | null = null;
  private resource: string | null = null;
  private lost: ((reason: string) => void) | null = null;
  private lostFired = false;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pendingIce: string[] = [];
  private closing = false;

  constructor(private readonly opts: WhipOptions) {}

  onLost(cb: (reason: string) => void): void {
    this.lost = cb;
  }

  async connect(stream: MediaStream, options: ConnectOptions = {}): Promise<void> {
    const pc = (this.opts.createPeer ?? (() => new RTCPeerConnection()))();
    this.pc = pc;
    try {
      for (const track of stream.getTracks()) pc.addTransceiver(track, { direction: "sendonly", streams: [stream] });
      await this.limitVideoBitrate(pc, options.maxVideoKbps);

      pc.onicecandidate = (ev) => {
        if (!ev.candidate) return;
        const line = `a=${ev.candidate.candidate}\r\n`;
        if (this.resource) void this.sendIce(line);
        else this.pendingIce.push(line);
      };
      const connected = this.waitConnected(pc, this.opts.connectTimeoutMs ?? 10_000);
      pc.onconnectionstatechange = () => this.onState(pc);

      await pc.setLocalDescription(await pc.createOffer());
      await this.waitGathered(pc, this.opts.gatherTimeoutMs ?? 2_000);
      const sdp = pc.localDescription?.sdp;
      if (!sdp) throw new Error("Offre SDP vide.");

      const { answer, resource } = await this.opts.signaling.offer(sdp);
      this.resource = resource;
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
      if (this.pendingIce.length) void this.sendIce(this.pendingIce.splice(0).join(""));
      await connected;
    } catch (e) {
      await this.close();
      throw classifySignalingError(e);
    }
  }

  async getStats(): Promise<TransportStats> {
    const out: TransportStats = { bytesSent: 0 };
    if (!this.pc) return out;
    const report = await this.pc.getStats();
    report.forEach((r: Record<string, unknown>) => {
      if (r.type === "outbound-rtp" && typeof r.bytesSent === "number") {
        out.bytesSent += r.bytesSent;
        if (r.kind === "video" && typeof r.framesPerSecond === "number") out.fps = r.framesPerSecond;
      }
      if (r.type === "candidate-pair" && r.state === "succeeded" && typeof r.currentRoundTripTime === "number") {
        out.rttMs = Math.round(r.currentRoundTripTime * 1000);
      }
    });
    return out;
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    clearTimeout(this.graceTimer);
    const resource = this.resource;
    this.resource = null;
    if (resource) await this.opts.signaling.close(resource).catch(() => undefined);
    if (this.pc) {
      this.pc.onconnectionstatechange = null;
      this.pc.onicecandidate = null;
      this.pc.close();
    }
  }

  private async sendIce(fragment: string): Promise<void> {
    if (!this.resource) return;
    await this.opts.signaling.patchIce(this.resource, fragment).catch(() => undefined);
  }

  private fireLost(reason: string) {
    if (this.lostFired || this.closing) return;
    this.lostFired = true;
    this.lost?.(reason);
  }

  private onState(pc: RTCPeerConnection) {
    clearTimeout(this.graceTimer);
    if (pc.connectionState === "failed" || pc.connectionState === "closed") this.fireLost("Liaison perdue.");
    else if (pc.connectionState === "disconnected") {
      this.graceTimer = setTimeout(() => this.fireLost("Liaison interrompue."), this.opts.disconnectGraceMs ?? 3_000);
    }
  }

  private waitConnected(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Liaison WebRTC non établie à temps.")), timeoutMs);
      const check = () => {
        if (pc.connectionState === "connected") {
          clearTimeout(timer);
          resolve();
        } else if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          clearTimeout(timer);
          reject(new Error("Liaison WebRTC refusée."));
        }
      };
      pc.addEventListener("connectionstatechange", check);
      check();
    });
  }

  private waitGathered(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      };
      const onChange = () => pc.iceGatheringState === "complete" && done();
      const timer = setTimeout(done, timeoutMs);
      pc.addEventListener("icegatheringstatechange", onChange);
    });
  }

  private async limitVideoBitrate(pc: RTCPeerConnection, kbps?: number) {
    if (!kbps) return;
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind !== "video") continue;
      const params = sender.getParameters();
      params.encodings = params.encodings?.length ? params.encodings : [{}];
      params.encodings[0].maxBitrate = kbps * 1000;
      await sender.setParameters(params).catch(() => undefined);
    }
  }
}

/** Les erreurs de signalisation qui ne se règlent pas en réessayant. */
export function classifySignalingError(e: unknown): Error {
  if (e instanceof ApiError) {
    if (e.status === 401 || e.status === 403) return new FatalError("Cet appareil n'est plus autorisé à diffuser.");
    if (e.status === 409) return new FatalError(e.message, "conflict");
  }
  return e instanceof Error ? e : new Error(String(e));
}
