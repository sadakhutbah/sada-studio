import { useEffect, useMemo, useRef, useState } from "react";
import { createLevelMeter } from "@core/audio/meter";
import { LiveKeeper } from "@core/kiosk/live-keeper";
import { evaluateHealth, toChecks, type HealthItem } from "@core/health/health";
import type { SessionState } from "@core/session/machine";
import type { BroadcastSession, SessionSnapshot } from "@core/session/broadcast-session";
import type { SourceOptions } from "@core/sources/types";
import type { KioskSnapshot } from "@shared/ipc";
import { createBroadcast } from "./studio";

export interface DeviceLists {
  cameras: MediaDeviceInfo[];
  microphones: MediaDeviceInfo[];
}

/** Liste caméras et micros ; relue quand un périphérique est branché ou débranché. */
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
  useEffect(() => () => broadcast.source.release(), [broadcast]);
  return { ...broadcast, snapshot };
}

const SILENT = { rms: -100, peak: -100 };

/** Vu-mètre : niveau (dBFS) rafraîchi à l'écran, ~30 fois par seconde. */
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

/** Horloge d'une seconde pour la durée du direct. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** État du boîtier, tenu par le processus principal ; l'interface le suit. */
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

/**
 * Fait coller la session à l'ordre du serveur (voir `LiveKeeper`). Rend la prochaine nouvelle tentative annoncée.
 * Les options de capture sont lues au moment du démarrage : elles peuvent changer sans relancer le gardien.
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

/** Contrôles du poste : réglages Windows relus chaque minute (lecture seule), matériel vu par le navigateur. */
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
  return useMemo(
    () => evaluateHealth({ windows: facts, cameras, microphones, schedule: kiosk.schedule, now, vaultPersistent: kiosk.persistent }),
    [facts, cameras, microphones, kiosk.schedule, kiosk.persistent, Math.floor(now / 60_000)], // eslint-disable-line
  );
}

/**
 * Dernière erreur de session (gardée jusqu'au prochain direct réussi) et échec de démarrage du direct demandé,
 * puis rapport au processus principal : état, matériel, contrôles. Le battement vers le serveur en est nourri.
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
  // Ajustement d'état pendant le rendu (voir la documentation de React) : pas d'effet intermédiaire.
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
    // Le débit change sans cesse : il est renvoyé à intervalle fixe, pas à chaque changement.
    const id = setInterval(send, 10_000);
    return () => clearInterval(id);
  }, [state.status, camera, micro, checks, lastError, startFailure]);
}
