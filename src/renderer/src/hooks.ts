import { useEffect, useMemo, useRef, useState } from "react";
import { createLevelMeter } from "@core/audio/meter";
import type { SessionSnapshot } from "@core/session/broadcast-session";
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
