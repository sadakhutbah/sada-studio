/**
 * The pictures the studio composes the programme with, fetched and kept up to date:
 * - the mosque logo (`logo.png`, ETag), for the logo overlay;
 * - each scene's picture: the mosque's template screen rendered locally (HTML → hidden window → frame, countdown
 *   updated every second), or else the engine's picture (`scene/{id}.png`, ETag);
 * - pre-rendered for the scenes likely to come next, so taking them on air is instant.
 * The last valid picture of a scene is kept through any failure: the programme never goes black.
 *
 * DOM-free: decoding and frame sinks are injected (ImageBitmap and canvas in the app, plain objects in tests).
 */
import type { AssetFetch, ScreenDescriptor, ScreenFetch } from "../api/types";
import type { BrowserSourceFrame } from "../sources/types";
import { AssetCache, nextMinute } from "./asset-cache";
import { programSceneKind } from "./logic";
import { countdownAt, ecranFor, fillScreen, probableNext, type FilledScreen } from "./screen-fill";
import type { ProgramView } from "./types";

export interface ScreenRenderRequest {
  key: string;
  html: string;
  transparent: boolean;
  countdown: string | null;
}

/** What the compositor needs from the outside (the IPC bridge in the app, fakes in tests). */
export interface ProgramIO {
  logo(etag: string | null): Promise<AssetFetch>;
  sceneImage(id: string, setup: boolean, etag: string | null): Promise<AssetFetch>;
  screen(id: string, setup: boolean, etag: string | null): Promise<ScreenFetch>;
  render(req: ScreenRenderRequest): Promise<BrowserSourceFrame>;
}

export interface FrameSink<S> {
  readonly source: S;
  put(frame: BrowserSourceFrame): void;
  release(): void;
}

export interface ProgramAssetsDeps<I, S> {
  io: ProgramIO;
  decode(png: Uint8Array): Promise<I>;
  release?(image: I): void;
  createSink(): FrameSink<S>;
  now?(): number;
  /** A picture appeared or changed (the compositor redraws its overlay layer when it is the logo). */
  onChange?(what: "logo" | "scene", id: string): void;
}

/** Revalidation of the logo: it rarely changes. */
export const LOGO_REFRESH_MS = 5 * 60_000;
/** A template render that failed is not retried for this long (the engine's picture is shown meanwhile). */
export const RENDER_RETRY_MS = 30_000;

/**
 * Which picture shows a scene: the template frame while it is current (or the newest render failed but nothing
 * else is there), the engine's picture otherwise, and any last valid frame rather than nothing.
 */
export function pickSceneSource(o: { gabarit: boolean; frame: boolean; frameCurrent: boolean; png: boolean }): "frame" | "png" | "none" {
  if (o.gabarit && o.frame && o.frameCurrent) return "frame";
  if (o.png) return "png";
  if (o.frame) return "frame";
  return "none";
}

interface Rendered<S> {
  sink: FrameSink<S>;
  /** Page identity of the frame held (null: none yet). */
  docKey: string | null;
  countdown: string | null;
  failedKey: string | null;
  failedAt: number;
  filled: { etag: string; text: string | null; result: FilledScreen } | null;
}

export class ProgramAssets<I, S> {
  private readonly logoCache: AssetCache<Uint8Array, I>;
  private readonly pngs: AssetCache<Uint8Array, I>;
  private readonly screens: AssetCache<{ etag: string; screen: ScreenDescriptor }, { etag: string; screen: ScreenDescriptor }>;
  private readonly rendered = new Map<string, Rendered<S>>();
  private readonly now: () => number;
  private setup = false;
  private rendering = false;

  constructor(private readonly d: ProgramAssetsDeps<I, S>) {
    this.now = d.now ?? Date.now;
    const release = (v: I) => d.release?.(v);
    const png = (r: AssetFetch) => (r.changed ? { changed: true as const, etag: r.etag, data: r.png } : r);
    this.logoCache = new AssetCache({
      fetch: async (_k, etag) => png(await d.io.logo(etag)),
      decode: (data) => d.decode(data),
      release,
      now: this.now,
      staleAt: (t) => t + LOGO_REFRESH_MS,
      onChange: () => d.onChange?.("logo", "logo"),
    });
    this.pngs = new AssetCache({
      fetch: async (id, etag) => png(await d.io.sceneImage(id, this.setup, etag)),
      decode: (data) => d.decode(data),
      release,
      now: this.now,
      onChange: (id) => d.onChange?.("scene", id),
    });
    this.screens = new AssetCache({
      fetch: async (id, etag) => {
        const r = await d.io.screen(ecranFor(id) ?? id, this.setup, etag);
        return r.changed ? { changed: true, etag: r.etag, data: r.screen ? { etag: r.etag, screen: r.screen } : null } : r;
      },
      decode: (v) => v,
      now: this.now,
      staleAt: nextMinute,
    });
  }

  /** The rehearsal (setup view) and the live are different programmes: their validators never mix. */
  setScope(setup: boolean): void {
    if (setup === this.setup) return;
    this.setup = setup;
    this.logoCache.forgetValidators();
    this.pngs.forgetValidators();
    this.screens.forgetValidators();
    for (const r of this.rendered.values()) r.failedKey = null;
  }

  logo(): I | null {
    return this.logoCache.get("logo");
  }

  /** The mosque has no logo (404): the engine's neutral emblem is drawn instead. */
  logoMissing(): boolean {
    return this.logoCache.isMissing("logo");
  }

  /** What to draw for scene `id` (null: nothing valid yet). */
  sceneSource(id: string): I | S | null {
    const desc = this.screens.get(id)?.screen;
    const r = this.rendered.get(id);
    const gabarit = desc?.source === "gabarit" && Boolean(desc.html);
    const frame = Boolean(r?.docKey);
    const frameCurrent = frame && r!.failedKey === null && r!.docKey!.startsWith(this.docPrefix(id));
    const pick = pickSceneSource({ gabarit, frame, frameCurrent, png: this.pngs.has(id) });
    if (pick === "frame") return r!.sink.source;
    if (pick === "png") return this.pngs.get(id);
    return null;
  }

  /**
   * Nothing more is coming for this scene right now: a picture is there, or the server has none (both the screen
   * and the picture answered). The compositor starts a transition once the incoming scene is settled.
   */
  settled(id: string): boolean {
    if (this.sceneSource(id) !== null) return true;
    const screenDone = ecranFor(id) === null || this.screens.settled(id) || this.screens.failures(id) > 0;
    const pngDone = this.pngs.settled(id) || this.pngs.failures(id) > 0;
    return screenDone && pngDone && !this.rendering;
  }

  /**
   * Housekeeping, about once a second while the studio composes: revalidates what is due, renders the template
   * pages (current scene's countdown each second), pre-renders the probable next scenes, drops the others.
   * `keep`: other scenes still drawn (the outgoing scene of a transition).
   */
  tick(view: ProgramView, keep: readonly string[] = []): Promise<void> {
    const ids = view.scenes.map((s) => s.id);
    const kindOf = (id: string) => (id === view.scene ? view.sceneKind : programSceneKind(view.scenes.find((s) => s.id === id)));
    const drawn = (id: string) => kindOf(id) !== "camera";
    const wanted: string[] = [];
    for (const id of [view.scene, ...keep, ...probableNext(view.scene, ids)]) {
      if (id && !wanted.includes(id) && drawn(id)) wanted.push(id);
    }
    const keepSet = new Set(wanted);
    this.pngs.retain(keepSet);
    this.screens.retain(keepSet);
    for (const [id, r] of this.rendered) {
      if (!keepSet.has(id)) {
        r.sink.release();
        this.rendered.delete(id);
      }
    }
    const jobs: Promise<void>[] = [];
    jobs.push(this.logoCache.refresh("logo"));
    for (const id of wanted) jobs.push(this.updateScene(id, id === view.scene));
    return Promise.all(jobs).then(() => undefined);
  }

  dispose(): void {
    this.logoCache.clear();
    this.pngs.clear();
    this.screens.clear();
    for (const r of this.rendered.values()) r.sink.release();
    this.rendered.clear();
  }

  /** Identity of a scene's page: programme (live or rehearsal), scene, version of its description. */
  private docPrefix(id: string): string {
    return `${this.setup ? "setup" : "live"}:${id}:${this.screens.get(id)?.etag ?? ""}:`;
  }

  private async updateScene(id: string, current: boolean): Promise<void> {
    if (ecranFor(id) !== null) {
      await this.screens.refresh(id, current && !this.screens.settled(id));
      const entry = this.screens.get(id);
      if (entry?.screen.source === "gabarit" && entry.screen.html) {
        const ok = await this.render(id, entry.etag, entry.screen, current);
        if (ok) return;
      }
    }
    // No template for this scene (or its rendering failed): the engine's picture.
    await this.pngs.refresh(id, current && !this.pngs.settled(id));
  }

  /** Renders (or updates the countdown of) the template page of scene `id`; false when no valid frame is available. */
  private async render(id: string, etag: string, screen: ScreenDescriptor, current: boolean): Promise<boolean> {
    let r = this.rendered.get(id);
    if (!r) {
      r = { sink: this.d.createSink(), docKey: null, countdown: null, failedKey: null, failedAt: 0, filled: null };
      this.rendered.set(id, r);
    }
    const now = this.now();
    const cd = screen.countdown;
    const text = cd ? countdownAt(cd.target, now) : null;
    // Filling a page is a string pass over up to a megabyte: once per version, and per second only when the countdown
    // cannot be updated in place (it sits in an attribute).
    if (!r.filled || r.filled.etag !== etag || (!r.filled.result.marked && r.filled.text !== text)) {
      r.filled = { etag, text, result: fillScreen(screen.html!, screen.values, cd && text !== null ? { variable: cd.variable, text } : null) };
    }
    const { html, marked } = r.filled.result;
    const docKey = `${this.docPrefix(id)}${marked ? "" : (text ?? "")}`;
    if (r.failedKey === docKey && now - r.failedAt < RENDER_RETRY_MS) return false;
    const upToDate = r.docKey === docKey && (!marked || !current || r.countdown === text);
    if (upToDate) return true;
    if (this.rendering) return r.docKey !== null; // one render at a time; the next tick catches up
    this.rendering = true;
    try {
      const frame = await this.d.io.render({ key: docKey, html, transparent: screen.transparent, countdown: marked ? text : null });
      if (this.rendered.get(id) !== r) return false;
      r.sink.put(frame);
      r.docKey = docKey;
      r.countdown = text;
      r.failedKey = null;
      this.d.onChange?.("scene", id);
      return true;
    } catch {
      r.failedKey = docKey;
      r.failedAt = this.now();
      return false;
    } finally {
      this.rendering = false;
    }
  }
}
