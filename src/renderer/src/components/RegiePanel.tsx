import { useEffect, useRef, useState } from "react";
import type {
  LiveOverlays,
  LiveStatus,
  OverlayCorner,
  OverlayKind,
  RegieData,
  RegieScene,
  TransitionMode,
} from "@core/api/types";
import { meterPosition } from "@core/audio/meter";
import { Poller, WriteFence, backoffDelayMs } from "@core/regie/poller";
import { bridge } from "../bridge";
import type { RegieLiveView } from "../regie-preview";
import { resolveRegieShortcut } from "../regie-shortcuts";
import { Btn, Card } from "../ui";
import { fr as t } from "../strings";

const DEFAULT_OVERLAYS: LiveOverlays = {
  qr: { visible: false, url: "", label: "", corner: "tr" },
  banner: { visible: false, title: "", subtitle: "" },
  logo: { visible: false },
};

const FALLBACK_SCENES: RegieScene[] = [
  { id: "khutba", kind: "camera", label: t.regie.scene.live },
  { id: "avant", kind: "slate", label: t.regie.scene.before },
  { id: "priere", kind: "slate", label: t.regie.scene.prayer },
  { id: "entracte", kind: "slate", label: t.regie.scene.intermission },
  { id: "termine", kind: "slate", label: t.regie.scene.ended },
];

const POLL_MS = 3000;
const POLL_MAX_MS = 30_000;
/** Consecutive failed polls before the data shown is flagged as out of date. */
const STALE_AFTER_FAILURES = 2;

const CORNERS: OverlayCorner[] = ["tl", "tr", "bl", "br"];

const inputCls =
  "min-h-9 rounded-[7px] border border-[#b9ae94] bg-white px-2.5 py-1.5 text-[0.9rem] text-ink placeholder:text-[#6f7a73] focus:border-deep disabled:bg-paper-2 disabled:text-muted";
const smallBtn = "min-h-8 px-2.5 py-1 text-[0.84rem]";

/** Incoming-audio strip: real-time level (dBFS) and mute of the stream feeding the broadcast. */
export interface RegieAudioProps {
  level: { rms: number; peak: number };
  muted: boolean;
  onToggleMute: () => void;
  /** The last mute change the server refused or never received (the local state was rolled back). */
  error?: string | null;
}

export interface RegiePanelProps {
  /** Scene and overlays currently requested: drawn over the monitor by the parent. */
  onLiveChange?: (view: RegieLiveView) => void;
  audio?: RegieAudioProps;
}

/** Level meter + mute button of the Régie panel. */
export function AudioStrip({ level, muted, onToggleMute, error }: RegieAudioProps) {
  const shown = muted ? -100 : level.rms;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-[0.76rem] font-semibold uppercase tracking-[0.1em] text-green">
        <span>{t.regie.audio}</span>
        <span className="font-normal normal-case tracking-normal tabular-nums">
          {muted ? t.regie.audioMuted : shown <= -99 ? "—" : `${Math.round(shown)} dB`}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <div
          role="meter"
          aria-label={t.regie.audioLevel}
          aria-valuemin={-60}
          aria-valuemax={0}
          aria-valuenow={Math.round(Math.max(-60, shown))}
          className="h-2.5 flex-1 overflow-hidden rounded-full bg-paper-2"
        >
          <div
            className="h-full rounded-full transition-[width] duration-75"
            style={{
              width: `${meterPosition(shown) * 100}%`,
              background: muted ? "#6b7280" : level.peak > -3 ? "#ef4444" : level.peak > -12 ? "#eab308" : "#22c55e",
            }}
          />
        </div>
        <Btn variante={muted ? "plein" : "ghost"} className={smallBtn} aria-pressed={muted} onClick={onToggleMute}>
          {muted ? t.regie.unmute : t.regie.mute}
        </Btn>
      </div>
      {error && (
        <p role="alert" className="m-0 text-[0.82rem] text-live">
          {error}
        </p>
      )}
    </div>
  );
}

function EyeBtn({
  visible,
  label,
  disabled,
  onClick,
}: {
  visible: boolean;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={visible}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[7px] border transition-colors ${
        visible
          ? "border-leaf bg-leaf/20 text-leaf"
          : "border-[#b9ae94] bg-white text-muted hover:text-ink"
      } disabled:opacity-50`}
    >
      {visible ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
          <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c6.5 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
          <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3.5 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
          <line x1="2" y1="2" x2="22" y2="22" />
        </svg>
      )}
    </button>
  );
}

export function RegiePanel({ audio, onLiveChange }: RegiePanelProps) {
  const [data, setData] = useState<RegieData | null>(null);
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [staged, setStaged] = useState<string>("khutba");
  const [transition, setTransition] = useState<TransitionMode>("fade");
  const [overlays, setOverlays] = useState<LiveOverlays>(DEFAULT_OVERLAYS);
  const [qrUrl, setQrUrl] = useState("");
  const [qrLabel, setQrLabel] = useState("");
  const [qrCorner, setQrCorner] = useState<OverlayCorner>("tr");
  const [bannerTitle, setBannerTitle] = useState("");
  const [bannerSubtitle, setBannerSubtitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [pollFailures, setPollFailures] = useState(0);
  const fence = useRef(new WriteFence());
  const [err, setErr] = useState<string | null>(null);

  function hydrateOverlays(ov?: LiveOverlays, updateFields = false) {
    if (!ov) return;
    setOverlays(ov);
    if (updateFields) {
      setQrUrl(ov.qr.url || "");
      setQrLabel(ov.qr.label || "");
      setQrCorner(ov.qr.corner || "tr");
      setBannerTitle(ov.banner.title || "");
      setBannerSubtitle(ov.banner.subtitle || "");
    }
  }

  useEffect(() => {
    let active = true;
    bridge.regie
      .get()
      .then((d) => {
        if (!active) return;
        setData(d);
        setStatus(d.status);
        if (d.transition === "fade" || d.transition === "cut") setTransition(d.transition);
        hydrateOverlays(d.overlays ?? d.status?.overlays, true);
      })
      .catch((e) => {
        if (active) setErr(e instanceof Error ? e.message : String(e));
      });

    const poller = new Poller({
      run: async () => {
        const stillCurrent = fence.current.begin();
        const s = await bridge.regie.status();
        // A command issued while this poll was in flight wins: its own answer already refreshed the state.
        if (!active || !stillCurrent()) return;
        setStatus(s);
        if (s.transition === "fade" || s.transition === "cut") setTransition(s.transition);
        if (s.overlays) setOverlays(s.overlays);
      },
      delayMs: backoffDelayMs(POLL_MS, POLL_MAX_MS),
      isHidden: () => document.hidden,
      onFailures: (n) => active && setPollFailures(n),
    });
    // The first poll is the `get()` above; the loop starts after one interval.
    const first = window.setTimeout(() => poller.start(), POLL_MS);
    const onVisibility = () => {
      if (!document.hidden) poller.wake();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      active = false;
      window.clearTimeout(first);
      poller.stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  async function sendCmd(cmd: string, arg?: string, tr?: TransitionMode) {
    fence.current.bump();
    setBusy(true);
    setErr(null);
    try {
      await bridge.regie.command(cmd, arg, tr);
      const s = await bridge.regie.status();
      setStatus(s);
      setPollFailures(0);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function takeScene(sceneId: string) {
    if (sceneId === "janaza") {
      await sendCmd("janaza", undefined, transition);
    } else {
      await sendCmd("scene", sceneId, transition);
    }
  }
  // Latest takeScene for the keyboard shortcut, without re-binding the listener every render.
  const takeSceneRef = useRef(takeScene);
  useEffect(() => {
    takeSceneRef.current = takeScene;
  });

  async function changeTransition(mode: TransitionMode) {
    fence.current.bump();
    setTransition(mode);
    setErr(null);
    try {
      const r = await bridge.regie.setTransition(mode);
      setTransition(r.transition);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function updateOverlay(kind: OverlayKind, payload: Record<string, unknown>) {
    fence.current.bump();
    setBusy(true);
    setErr(null);
    try {
      const r = await bridge.regie.setOverlay(kind, payload);
      hydrateOverlays(r.overlays, true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const st = status || data?.status || {};
  const reachable = Boolean(st.reachable);
  const scene = st.scene || "";
  const isAuto = !st.override;
  const displayErr = err;
  const scenesList = data?.scenes && data.scenes.length > 0 ? data.scenes : FALLBACK_SCENES;

  useEffect(() => {
    onLiveChange?.({ scene, scenes: scenesList, overlays });
  }, [onLiveChange, scene, scenesList, overlays]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const action = resolveRegieShortcut(
        {
          key: e.key,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          altKey: e.altKey,
          target: e.target instanceof HTMLElement ? e.target : null,
        },
        scenesList.length,
      );
      if (!action) return;
      if (action.type === "stage") {
        const sc = scenesList[action.index];
        if (sc) setStaged(sc.id);
      } else if (action.type === "take" && reachable && !busy) {
        e.preventDefault();
        void takeSceneRef.current(staged);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [scenesList, staged, reachable, busy, transition]);

  return (
    <Card title={t.regie.title}>
      <div className="flex flex-col gap-3">
        {pollFailures >= STALE_AFTER_FAILURES && (
          <div role="status" className="rounded-[7px] border border-warn/40 bg-warn-bg px-2.5 py-1.5 text-[0.84rem] text-warn">
            {t.regie.stale}
          </div>
        )}
        {displayErr && (
          <div className="rounded-[7px] border border-live/40 bg-err-bg px-2.5 py-1.5 text-[0.84rem] text-[#7a1f20]">
            {displayErr}
          </div>
        )}

        {/* Scènes */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-[0.76rem] font-semibold uppercase tracking-[0.1em] text-green">
            <span>{t.regie.scenes}</span>
            <div className="flex items-center gap-1.5">
              <Btn
                variante={transition === "fade" ? "plein" : "ghost"}
                className={smallBtn}
                disabled={busy}
                onClick={() => void changeTransition("fade")}
              >
                {t.regie.transitions.fade}
              </Btn>
              <Btn
                variante={transition === "cut" ? "plein" : "ghost"}
                className={smallBtn}
                disabled={busy}
                onClick={() => void changeTransition("cut")}
              >
                {t.regie.transitions.cut}
              </Btn>
              {!reachable && <span className="font-normal normal-case tracking-normal">{t.regie.offline}</span>}
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {scenesList.map((s) => (
              <Btn
                key={s.id}
                variante={scene === s.id ? "plein" : "ghost"}
                className={`${smallBtn} ${staged === s.id && scene !== s.id ? "ring-1 ring-leaf" : ""}`}
                disabled={busy || !reachable}
                data-regie-scene={s.id}
                onClick={() => {
                  setStaged(s.id);
                  void takeScene(s.id);
                }}
              >
                {s.label}
              </Btn>
            ))}
            <Btn
              variante={isAuto && reachable ? "plein" : "ghost"}
              className={smallBtn}
              disabled={busy || !reachable}
              onClick={() => void sendCmd("auto")}
            >
              {t.regie.auto}
            </Btn>
          </div>
        </div>

        {audio && (
          <div className="border-t border-line pt-3">
            <AudioStrip {...audio} />
          </div>
        )}

        {/* Incrustations serveur */}
        <div className="flex flex-col gap-2.5 border-t border-line pt-3">
          <div className="text-[0.76rem] font-semibold uppercase tracking-[0.1em] text-green">
            {t.regie.overlays}
          </div>

          {/* QR code */}
          <div className="flex flex-wrap items-center gap-1.5">
            <EyeBtn
              visible={overlays.qr.visible}
              label={`${overlays.qr.visible ? t.regie.hide : t.regie.show} — ${t.regie.qr}`}
              disabled={busy}
              onClick={() =>
                void updateOverlay("qr", {
                  visible: !overlays.qr.visible,
                  url: qrUrl,
                  label: qrLabel,
                  corner: qrCorner,
                })
              }
            />
            <span className="min-w-[115px] text-[0.9rem] font-semibold text-ink">{t.regie.qr}</span>
            <input
              type="url"
              value={qrUrl}
              onChange={(e) => setQrUrl(e.target.value)}
              placeholder={t.regie.qrUrl}
              maxLength={512}
              className={`${inputCls} min-w-[170px] flex-1`}
            />
            <input
              type="text"
              value={qrLabel}
              onChange={(e) => setQrLabel(e.target.value)}
              placeholder={t.regie.qrLabel}
              maxLength={60}
              className={`${inputCls} min-w-[120px] flex-1`}
            />
            <select
              value={qrCorner}
              onChange={(e) => setQrCorner(e.target.value as OverlayCorner)}
              aria-label={t.regie.qr}
              className={inputCls}
            >
              {CORNERS.map((c) => (
                <option key={c} value={c}>
                  {t.regie.corners[c]}
                </option>
              ))}
            </select>
            <Btn
              variante="ghost"
              className={smallBtn}
              disabled={busy}
              onClick={() =>
                void updateOverlay("qr", {
                  visible: overlays.qr.visible,
                  url: qrUrl,
                  label: qrLabel,
                  corner: qrCorner,
                })
              }
            >
              {t.regie.apply}
            </Btn>
          </div>

          {/* Bandeau / Annonce */}
          <div className="flex flex-wrap items-center gap-1.5 border-t border-line pt-2.5">
            <EyeBtn
              visible={overlays.banner.visible}
              label={`${overlays.banner.visible ? t.regie.hide : t.regie.show} — ${t.regie.banner}`}
              disabled={busy}
              onClick={() =>
                void updateOverlay("banner", {
                  visible: !overlays.banner.visible,
                  title: bannerTitle,
                  subtitle: bannerSubtitle,
                })
              }
            />
            <span className="min-w-[115px] text-[0.9rem] font-semibold text-ink">{t.regie.banner}</span>
            <input
              type="text"
              value={bannerTitle}
              onChange={(e) => setBannerTitle(e.target.value)}
              placeholder={t.regie.bannerTitle}
              maxLength={120}
              className={`${inputCls} min-w-[170px] flex-1`}
            />
            <input
              type="text"
              value={bannerSubtitle}
              onChange={(e) => setBannerSubtitle(e.target.value)}
              placeholder={t.regie.bannerSubtitle}
              maxLength={160}
              className={`${inputCls} min-w-[140px] flex-1`}
            />
            <Btn
              variante="ghost"
              className={smallBtn}
              disabled={busy}
              onClick={() =>
                void updateOverlay("banner", {
                  visible: overlays.banner.visible,
                  title: bannerTitle,
                  subtitle: bannerSubtitle,
                })
              }
            >
              {t.regie.apply}
            </Btn>
          </div>

          {/* Logo de la mosquée */}
          <div className="flex items-center gap-1.5 border-t border-line pt-2.5">
            <EyeBtn
              visible={overlays.logo.visible}
              label={`${overlays.logo.visible ? t.regie.hide : t.regie.show} — ${t.regie.logo}`}
              disabled={busy}
              onClick={() => void updateOverlay("logo", { visible: !overlays.logo.visible })}
            />
            <span className="text-[0.9rem] font-semibold text-ink">{t.regie.logo}</span>
          </div>
        </div>
      </div>
    </Card>
  );
}
