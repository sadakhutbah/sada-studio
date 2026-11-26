/**
 * Mix of the broadcast sound: the local microphone (always) plus the sound of the shared screen and of the web page,
 * each with its own on/off and volume. The output is one Web Audio destination track that never changes, so the live
 * only has to swap the audio sender between the raw microphone track and this one (`replaceTrack`, no reconnection).
 * While no extra source is audible the mix is inactive and the raw microphone goes out untouched.
 */
export type MixInputId = "screen" | "browser";
const EXTRA_IDS: readonly MixInputId[] = ["screen", "browser"];

export interface MixInputSettings {
  enabled: boolean;
  /** 0 (silent) to MAX_VOLUME; 1 is the source's own level. */
  volume: number;
}
export type MixSettings = Record<MixInputId, MixInputSettings>;

export const MAX_VOLUME = 2;
export const DEFAULT_MIX: MixSettings = { screen: { enabled: true, volume: 1 }, browser: { enabled: true, volume: 1 } };

export function clampVolume(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 1;
  return Math.min(MAX_VOLUME, Math.max(0, Math.round(n * 100) / 100));
}

/** Stored settings (any shape) as valid settings: defaults for what is missing or wrong. */
export function normalizeMixSettings(raw: unknown): MixSettings {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const one = (id: MixInputId): MixInputSettings => {
    const v = r[id] && typeof r[id] === "object" ? (r[id] as Record<string, unknown>) : {};
    return { enabled: typeof v.enabled === "boolean" ? v.enabled : DEFAULT_MIX[id].enabled, volume: clampVolume(v.volume ?? DEFAULT_MIX[id].volume) };
  };
  return { screen: one("screen"), browser: one("browser") };
}

export interface MixPlan {
  /** Gain of each extra source: 0 when absent, switched off or at zero volume. */
  gains: Record<MixInputId, number>;
  /** Something other than the microphone is audible: the mix is what goes out. */
  active: boolean;
}

/** Pure decision of the mix: which extra sources count, at which gain. `present`: the source has an audio track. */
export function planMix(present: Record<MixInputId, boolean>, settings: MixSettings): MixPlan {
  const gains = { screen: 0, browser: 0 } as Record<MixInputId, number>;
  for (const id of EXTRA_IDS) gains[id] = present[id] && settings[id].enabled ? clampVolume(settings[id].volume) : 0;
  return { gains, active: EXTRA_IDS.some((id) => gains[id] > 0) };
}

/** The part of Web Audio the mix needs (so that it can be replaced in tests). */
export interface MixAudioNode {
  connect(to: MixAudioNode): void;
  disconnect(): void;
}
export interface MixGainNode extends MixAudioNode {
  gain: { value: number };
}
export interface MixAudioContext {
  createMediaStreamSource(stream: MediaStream): MixAudioNode;
  createGain(): MixGainNode;
  createMediaStreamDestination(): MixAudioNode & { stream: MediaStream };
  resume?(): Promise<void>;
  close(): Promise<void>;
}

/** What `CompositedSource` needs from the mix (an interface so that it can be replaced in tests). */
export interface OutputAudioMix {
  /** Something other than the microphone is audible: `track` is what goes out. */
  readonly active: boolean;
  /** The mixed track: the same one for the whole life of the mix. */
  readonly track: MediaStreamTrack | null;
  setMic(stream: MediaStream | null): void;
  setInput(id: MixInputId, stream: MediaStream | null): void;
  onActiveChange(cb: () => void): () => void;
}

interface Wired {
  stream: MediaStream;
  source: MixAudioNode | null;
  gain: MixGainNode | null;
}

type Slot = MixInputId | "mic";

export class AudioSourceMix implements OutputAudioMix {
  private ctx: MixAudioContext | null = null;
  private destination: (MixAudioNode & { stream: MediaStream }) | null = null;
  private readonly streams: Record<Slot, MediaStream | null> = { mic: null, screen: null, browser: null };
  private readonly wired = new Map<Slot, Wired>();
  private settings: MixSettings = normalizeMixSettings(null);
  private lastActive = false;
  private readonly listeners = new Set<() => void>();

  /** `createContext` returns null where Web Audio is absent (tests, node): the mix then stays inactive. */
  constructor(private readonly createContext: () => MixAudioContext | null = defaultContext) {}

  get active(): boolean {
    return this.plan().active;
  }

  get track(): MediaStreamTrack | null {
    return this.destination?.stream.getAudioTracks()[0] ?? null;
  }

  get currentSettings(): MixSettings {
    return this.settings;
  }

  configure(settings: MixSettings): void {
    this.settings = normalizeMixSettings(settings);
    this.apply();
  }

  setMic(stream: MediaStream | null): void {
    this.setStream("mic", stream);
  }

  setInput(id: MixInputId, stream: MediaStream | null): void {
    this.setStream(id, stream);
  }

  onActiveChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  dispose(): void {
    for (const slot of this.wired.keys()) this.unwire(slot);
    this.listeners.clear();
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.destination = null;
  }

  private hasAudio(s: MediaStream | null): boolean {
    return s !== null && s.getAudioTracks().length > 0;
  }

  private plan(): MixPlan {
    return planMix({ screen: this.hasAudio(this.streams.screen), browser: this.hasAudio(this.streams.browser) }, this.settings);
  }

  private setStream(slot: Slot, stream: MediaStream | null): void {
    if (this.streams[slot] === stream) return;
    this.streams[slot] = stream;
    this.apply();
  }

  /** Brings the graph in line with the streams and settings, then tells whether the mix became (in)active. */
  private apply(): void {
    const plan = this.plan();
    // The context is only created once something has to be mixed: a camera-only live never touches Web Audio.
    if (plan.active && !this.ensureContext()) return;
    if (this.ctx) {
      for (const slot of ["mic", "screen", "browser"] as const) this.wire(slot, plan);
    }
    if (plan.active !== this.lastActive) {
      this.lastActive = plan.active;
      for (const cb of this.listeners) cb();
    }
  }

  private ensureContext(): boolean {
    if (this.ctx) return true;
    const ctx = this.createContext();
    if (!ctx) return false;
    this.ctx = ctx;
    this.destination = ctx.createMediaStreamDestination();
    void ctx.resume?.().catch(() => undefined);
    return true;
  }

  private wire(slot: Slot, plan: MixPlan): void {
    const ctx = this.ctx;
    const dest = this.destination;
    if (!ctx || !dest) return;
    const stream = this.streams[slot];
    const known = this.wired.get(slot);
    if (!stream || !this.hasAudio(stream)) {
      if (known) this.unwire(slot);
      return;
    }
    let node = known;
    if (!node || node.stream !== stream) {
      if (node) this.unwire(slot);
      const source = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();
      source.connect(gain);
      gain.connect(dest);
      node = { stream, source, gain };
      this.wired.set(slot, node);
    }
    if (node.gain) node.gain.gain.value = slot === "mic" ? 1 : plan.gains[slot];
  }

  private unwire(slot: Slot): void {
    const node = this.wired.get(slot);
    if (!node) return;
    node.source?.disconnect();
    node.gain?.disconnect();
    this.wired.delete(slot);
  }
}

function defaultContext(): MixAudioContext | null {
  if (typeof AudioContext === "undefined") return null;
  try {
    return new AudioContext({ latencyHint: "interactive" }) as unknown as MixAudioContext;
  } catch {
    return null;
  }
}
