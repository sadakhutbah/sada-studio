import { t } from "../messages";

/** WHEP signaling (read side of WHIP): one offer, one answer, one DELETE. The HTTP implementation is in `api/sada-api.ts`. */
export interface WhepSignaling {
  /** Sends the SDP offer; returns the SDP answer and the resource to close later (Location). */
  offer(sdp: string): Promise<{ answer: string; resource: string }>;
  close(resource: string): Promise<void>;
}

export interface WhepOptions {
  signaling: WhepSignaling;
  createPeer?: () => RTCPeerConnection;
  /** Maximum wait for ICE gathering before sending the offer. */
  gatherTimeoutMs?: number;
  connectTimeoutMs?: number;
  /** Grace delay before declaring a "disconnected" link lost (it often comes back by itself). */
  disconnectGraceMs?: number;
}

/** Receives one video stream from the relay (the programme the orchestrator composes), negotiated in one round trip. */
export class WhepPlayer {
  private pc: RTCPeerConnection | null = null;
  private resource: string | null = null;
  private lost: ((reason: string) => void) | null = null;
  private track: ((stream: MediaStream) => void) | null = null;
  private lostFired = false;
  private closing = false;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly opts: WhepOptions) {}

  onLost(cb: (reason: string) => void): void {
    this.lost = cb;
  }

  onStream(cb: (stream: MediaStream) => void): void {
    this.track = cb;
  }

  /** Resolves once the link is up. Rejects with the signaling error (404: nothing published yet) or a timeout. */
  async connect(): Promise<void> {
    const pc = (this.opts.createPeer ?? (() => new RTCPeerConnection()))();
    this.pc = pc;
    try {
      pc.addTransceiver("video", { direction: "recvonly" });
      pc.ontrack = (e) => this.track?.(e.streams[0] ?? new MediaStream([e.track]));
      const connected = this.waitConnected(pc, this.opts.connectTimeoutMs ?? 10_000);
      pc.onconnectionstatechange = () => this.onState(pc);
      await pc.setLocalDescription(await pc.createOffer());
      await this.waitGathered(pc, this.opts.gatherTimeoutMs ?? 2_000);
      const sdp = pc.localDescription?.sdp;
      if (!sdp) throw new Error(t("whip.emptyOffer"));
      const { answer, resource } = await this.opts.signaling.offer(sdp);
      this.resource = resource;
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
      await connected;
    } catch (e) {
      await this.close();
      throw e;
    }
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
      this.pc.ontrack = null;
      this.pc.close();
    }
  }

  private fireLost(reason: string) {
    if (this.lostFired || this.closing) return;
    this.lostFired = true;
    this.lost?.(reason);
  }

  private onState(pc: RTCPeerConnection) {
    clearTimeout(this.graceTimer);
    if (pc.connectionState === "failed" || pc.connectionState === "closed") this.fireLost("failed");
    else if (pc.connectionState === "disconnected") {
      this.graceTimer = setTimeout(() => this.fireLost("disconnected"), this.opts.disconnectGraceMs ?? 3_000);
    }
  }

  private waitConnected(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(t("whip.timeout"))), timeoutMs);
      const check = () => {
        if (pc.connectionState === "connected") {
          clearTimeout(timer);
          resolve();
        } else if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          clearTimeout(timer);
          reject(new Error(t("whip.refused")));
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
}
