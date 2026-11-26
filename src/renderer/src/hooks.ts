import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CaptureView } from "@core/capture/settings";
import { createLevelMeter } from "@core/audio/meter";
import { LiveKeeper } from "@core/kiosk/live-keeper";
import { evaluateHealth, toChecks, type HealthItem } from "@core/health/health";
import type { SessionState } from "@core/session/machine";
import type { BroadcastSession, SessionSnapshot } from "@core/session/broadcast-session";
import type { SourceOptions } from "@core/sources/types";
import type { SetupState } from "@core/api/types";
import { getLocale, type Locale } from "@core/messages";
import { subscribeLocale } from "./strings";
import { ApiError } from "@core/errors";
import { IDLE_LIMIT_MS, isIdle, renewDelayMs, setupPhase, type SetupPhase } from "@core/setup/view";
import type { KioskSnapshot } from "@shared/ipc";
import { bridge } from "./bridge";
import { createBroadcast } from "./studio";

/** The language in use; the component re-renders when it changes. */
export const useLocale = (): Locale => useSyncExternalStore(subscribeLocale, getLocale);

export interface DeviceLists {
  cameras: MediaDeviceInfo[];
  microphones: MediaDeviceInfo[];
}

/** Lists cameras and microphones; re-read when a device is plugged or unplugged. */
export function useDevices(refreshKey: unknown): DeviceLists {
  const [lists, setLists] = useState<DeviceLists>({ cameras: [], microphones: [] });
  useEffect(() => {
    let alive = true;
    const read = async () => {
      const all = await navigator.mediaDevices.enumerateDevices();
      if (!alive) return;
      setLists({
        cameras: all.filter((d) => d.kind === "videoinput"),
        microphones: all.filter((d) => d.kind === "audioinput"),
      });
    };
    void read();
    navigator.mediaDevices.addEventListener("devicechange", read);
    return () => {
      alive = false;
      navigator.mediaDevices.removeEventListener("devicechange", read);
    };
  }, [refreshKey]);
  return lists;
}

export function useBroadcast() {
  const broadcast = useMemo(() => createBroadcast(), []);
  const [snapshot, setSnapshot] = useState<SessionSnapshot>(broadcast.session.snapshot);
  useEffect(() => broadcast.session.subscribe(setSnapshot), [broadcast]);
  useEffect(() => () => broadcast.composited.release(), [broadcast]);
  return { ...broadcast, snapshot };
}

const SILENT = { rms: -100, peak: -100 };

/** Level meter: level (dBFS) refreshed on screen, ~30 times per second. */
export function useLevel(stream: MediaStream | null): { rms: number; peak: number } {
  const [level, setLevel] = useState({ rms: -100, peak: -100 });
  const raf = useRef(0);
  useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0) return;
    const meter = createLevelMeter(stream);
    let last = 0;
    const tick = (t: number) => {
      if (t - last > 33) {
        last = t;
        setLevel(meter.read());
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf.current);
      meter.dispose();
    };
  }, [stream]);
  return stream ? level : SILENT;
}

/** One-second clock for the live duration. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** Device state, held by the main process; the UI follows it. */
export function useKiosk(): KioskSnapshot | null {
  const [snap, setSnap] = useState<KioskSnapshot | null>(null);
  useEffect(() => {
    let alive = true;
    const off = window.studio.kiosk.onChange((s) => alive && setSnap(s));
    void window.studio.kiosk.get().then((s) => alive && setSnap((cur) => cur ?? s));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return snap;
}

/** State of the IP camera capture and its sound card list, held by the main process. */
export function useCapture(): { view: CaptureView | null; audioInputs: string[]; refreshAudioInputs: () => void } {
  const [view, setView] = useState<CaptureView | null>(null);
  const [audioInputs, setAudioInputs] = useState<string[]>([]);
  const refreshAudioInputs = useCallback(() => void window.studio.capture.devices().then(setAudioInputs), []);
  useEffect(() => {
    let alive = true;
    const off = window.studio.capture.onChange((v) => alive && setView(v));
    void window.studio.capture.get().then((v) => alive && setView((cur) => cur ?? v));
    refreshAudioInputs();
    return () => {
      alive = false;
      off();
    };
  }, [refreshAudioInputs]);
  return { view, audioInputs, refreshAudioInputs };
}

/**
 * Keeps the session in line with the server order (see `LiveKeeper`). Returns the next announced retry.
 * Capture options are read at start time: they can change without restarting the keeper.
 */
export function useKeeper(
  session: BroadcastSession,
  wanted: boolean,
  options: SourceOptions,
): { waitMs: number; at: number } | null {
  const [retry, setRetry] = useState<{ waitMs: number; at: number } | null>(null);
  const optionsRef = useRef(options);
  const keeperRef = useRef<LiveKeeper | null>(null);
  useEffect(() => {
    optionsRef.current = options;
  });
  useEffect(() => {
    const keeper = new LiveKeeper({
      get snapshot() {
        return session.snapshot;
      },
      subscribe: (fn) => session.subscribe(fn),
      start: () => session.start(optionsRef.current),
      stop: () => session.stop(),
    });
    keeperRef.current = keeper;
    const off = keeper.onRetry(setRetry);
    return () => {
      off();
      keeper.dispose();
      keeperRef.current = null;
    };
  }, [session]);
  useEffect(() => {
    keeperRef.current?.setWanted(wanted);
  }, [session, wanted]);
  return retry;
}

const FACTS_EVERY_MS = 60_000;

/** Workstation checks: Windows settings re-read every minute (read-only), hardware as seen by the browser. */
export function useHealth(kiosk: KioskSnapshot, cameras: number | null, microphones: number | null): HealthItem[] {
  const [facts, setFacts] = useState<Awaited<ReturnType<typeof window.studio.kiosk.windowsFacts>>>(null);
  useEffect(() => {
    let alive = true;
    const read = () => void window.studio.kiosk.windowsFacts().then((f) => alive && setFacts(f));
    read();
    const id = setInterval(read, FACTS_EVERY_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  const now = useNow(true);
  const locale = useLocale(); // the checks are texts: recomputed in the new language
  return useMemo(
    () => evaluateHealth({ windows: facts, cameras, microphones, schedule: kiosk.schedule, now, vaultPersistent: kiosk.persistent }),
    [facts, cameras, microphones, kiosk.schedule, kiosk.persistent, Math.floor(now / 60_000), locale], // eslint-disable-line
  );
}

/**
 * Last session error (kept until the next successful live) and start failure of the requested live,
 * then report to the main process: state, hardware, checks. The heartbeat to the server is fed from it.
 */
export function useReporter(
  state: SessionState,
  bitrateKbps: number,
  wantLive: boolean,
  stream: MediaStream | null,
  health: HealthItem[],
): void {
  const [lastError, setLastError] = useState<{ code: string; message: string } | null>(null);
  const [seen, setSeen] = useState({ status: state.status, error: state.error });
  // State adjustment during render (see the React documentation): no intermediate effect.
  if (seen.status !== state.status || seen.error !== state.error) {
    setSeen({ status: state.status, error: state.error });
    if (state.status === "error" && state.error) setLastError({ code: state.errorCode ?? "session", message: state.error });
    else if (state.status === "live") setLastError(null);
  }
  const startFailure = wantLive && state.status === "error" ? state.error : null;
  const latest = useRef(bitrateKbps);
  useEffect(() => {
    latest.current = bitrateKbps;
  });
  const camera = !!stream?.getVideoTracks().some((t) => t.readyState === "live");
  const micro = !!stream?.getAudioTracks().some((t) => t.readyState === "live");
  const checks = useMemo(() => toChecks(health), [health]);
  useEffect(() => {
    const send = () =>
      window.studio.kiosk.report({ sessionState: state.status, camera, micro, bitrateKbps: latest.current, checks, lastError, startFailure });
    send();
    // The bitrate changes constantly: it is sent at a fixed interval, not on every change.
    const id = setInterval(send, 10_000);
    return () => clearInterval(id);
  }, [state.status, camera, micro, checks, lastError, startFailure]);
}

export interface SetupMode {
  wanted: boolean;
  state: SetupState | null;
  error: "server" | "lapsed" | null;
  /** Shown once after the mode closed by itself (inactivity). */
  idleClosed: boolean;
  /** The programme picture reports whether it plays (set by the programme view). */
  setPlaying: (playing: boolean) => void;
  phase: SetupPhase;
  open: () => void;
  close: () => void;
}

/**
 * Setup mode: while open, the lease is renewed (every few seconds, which is also how the answer is polled: the
 * orchestrator may take a minute to wake). It closes by itself after a long inactivity so the orchestrator can
 * go back to sleep, and when the window goes away (the server's lease lapses by itself if even that is lost).
 */
export function useSetupMode(): SetupMode {
  const [wanted, setWanted] = useState(false);
  const [state, setState] = useState<SetupState | null>(null);
  const [error, setError] = useState<"server" | "lapsed" | null>(null);
  const [idleClosed, setIdleClosed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const lastActivity = useRef(0);
  const phase = setupPhase({ wanted, state, error, playing });
  const phaseRef = useRef(phase);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const open = useCallback(() => {
    setIdleClosed(false);
    lastActivity.current = Date.now();
    setWanted(true);
  }, []);
  const close = useCallback(() => setWanted(false), []);

  useEffect(() => {
    if (!wanted) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const touch = () => {
      lastActivity.current = Date.now();
    };
    const events = ["pointerdown", "keydown", "wheel"] as const;
    for (const e of events) window.addEventListener(e, touch, { passive: true });
    const renew = async () => {
      if (isIdle(lastActivity.current, Date.now(), IDLE_LIMIT_MS)) {
        setIdleClosed(true);
        setWanted(false);
        return;
      }
      try {
        const s = await bridge.setup.enter();
        if (!alive) return;
        setState(s);
        setError(null);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof ApiError && e.code === "setup_off" ? "lapsed" : "server");
      }
      if (alive) timer = setTimeout(() => void renew(), renewDelayMs(phaseRef.current));
    };
    void renew();
    return () => {
      alive = false;
      clearTimeout(timer);
      for (const e of events) window.removeEventListener(e, touch);
      setState(null);
      setError(null);
      setPlaying(false);
      void bridge.setup.leave().catch(() => undefined);
    };
  }, [wanted]);

  return { wanted, state, error, idleClosed, setPlaying, phase, open, close };
}
