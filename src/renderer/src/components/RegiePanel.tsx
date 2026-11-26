import { useEffect, useState } from "react";
import type { OverlayCorner, OverlayKind } from "@core/api/types";
import { meterPosition } from "@core/audio/meter";
import { Poller, backoffDelayMs } from "@core/regie/poller";
import {
  overlayKey,
  regieActions,
  selectDrafts,
  selectError,
  selectPending,
  selectPendingScene,
  selectScenes,
  selectStale,
  selectView,
} from "@core/regie/state";
import { applyOverlay, changeTransition, loadRegie, pollStatus, setAuto, takeScene, toggleOverlay } from "@core/regie/thunks";
import { resolveRegieShortcut } from "../regie-shortcuts";
import { useRegieDispatch, useRegieSelector } from "../store";
import { Btn, Card } from "../ui";
import { EyeBtn, inputCls, smallBtn } from "./regie-controls";
import { LocalSources, type LocalSourcesProps } from "./LocalSources";
import { str as t } from "../strings";

const POLL_MS = 3000;
const POLL_MAX_MS = 30_000;

const CORNERS: OverlayCorner[] = ["tl", "tr", "bl", "br"];


/** Incoming-audio strip: real-time level (dBFS) and mute of the stream feeding the broadcast. */
export interface RegieAudioProps {
  level: { rms: number; peak: number };
  muted: boolean;
  onToggleMute: () => void;
  /** Non-blocking warning: the change holds here but the server could not be told ("not synchronised"). */
  error?: string | null;
}

/**
 * The panel reads and writes the Régie store (`<Provider>` above it): no global busy state, only the control whose
 * command is on its way shows `aria-busy`.
 */
export interface RegiePanelProps {
  audio?: RegieAudioProps;
  /** Local sources (web source, screen share), driven by the studio screen. */
  localSources?: LocalSourcesProps;
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
        <p role="status" className="m-0 text-[0.82rem] text-warn">
          {error}
        </p>
      )}
    </div>
  );
}

export function RegiePanel({ audio, localSources }: RegiePanelProps) {
  const dispatch = useRegieDispatch();
  const view = useRegieSelector(selectView);
  const scenesList = useRegieSelector(selectScenes);
  const drafts = useRegieSelector(selectDrafts);
  const err = useRegieSelector(selectError);
  const stale = useRegieSelector(selectStale);
  const pendingScene = useRegieSelector(selectPendingScene);
  const transitionBusy = useRegieSelector((s) => selectPending(s, "transition"));
  const qrBusy = useRegieSelector((s) => selectPending(s, overlayKey("qr")));
  const bannerBusy = useRegieSelector((s) => selectPending(s, overlayKey("banner")));
  const logoBusy = useRegieSelector((s) => selectPending(s, overlayKey("logo")));
  const [staged, setStaged] = useState<string>("khutba");

  useEffect(() => {
    let active = true;
    // A new session of the panel (live or setup): answers meant for the previous one are dropped by the store.
    dispatch(regieActions.reset());
    void dispatch(loadRegie());
    const poller = new Poller({
      run: () => dispatch(pollStatus()),
      delayMs: backoffDelayMs(POLL_MS, POLL_MAX_MS),
      isHidden: () => document.hidden,
      onFailures: (n) => active && dispatch(regieActions.pollFailuresChanged(n)),
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
      // Not loaded any more: shortcuts and the local API take scenes through the main process until the next mount.
      dispatch(regieActions.reset());
    };
  }, [dispatch]);

  const reachable = view.reachable;
  const scene = view.scene;
  const isAuto = !view.override;
  const transition = view.transition;
  const overlays = view.overlays;

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
      } else if (action.type === "take" && reachable) {
        e.preventDefault();
        void dispatch(takeScene(staged));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dispatch, scenesList, staged, reachable]);

  const qrDraft = (patch: Partial<typeof drafts.qr>) => dispatch(regieActions.draftChanged({ qr: patch }));
  const bannerDraft = (patch: Partial<typeof drafts.banner>) => dispatch(regieActions.draftChanged({ banner: patch }));
  const overlayCmd = (kind: OverlayKind, mode: "toggle" | "apply") => void dispatch(mode === "toggle" ? toggleOverlay(kind) : applyOverlay(kind));

  return (
    <Card title={t.regie.title}>
      <div className="flex flex-col gap-3">
        {stale && (
          <div role="status" className="rounded-[7px] border border-warn/40 bg-warn-bg px-2.5 py-1.5 text-[0.84rem] text-warn">
            {t.regie.stale}
          </div>
        )}
        {err && (
          <div role="alert" className="rounded-[7px] border border-live/40 bg-err-bg px-2.5 py-1.5 text-[0.84rem] text-[#7a1f20]">
            {err}
          </div>
        )}

        {/* Scènes */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-[0.76rem] font-semibold uppercase tracking-[0.1em] text-green">
            <span>{t.regie.scenes}</span>
            <div className="flex items-center gap-1.5" aria-busy={transitionBusy || undefined}>
              <Btn
                variante={transition === "fade" ? "plein" : "ghost"}
                className={smallBtn}
                aria-pressed={transition === "fade"}
                onClick={() => void dispatch(changeTransition("fade"))}
              >
                {t.regie.transitions.fade}
              </Btn>
              <Btn
                variante={transition === "cut" ? "plein" : "ghost"}
                className={smallBtn}
                aria-pressed={transition === "cut"}
                onClick={() => void dispatch(changeTransition("cut"))}
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
                disabled={!reachable}
                aria-pressed={scene === s.id}
                aria-busy={pendingScene?.scene === s.id || undefined}
                data-regie-scene={s.id}
                onClick={() => {
                  setStaged(s.id);
                  void dispatch(takeScene(s.id));
                }}
              >
                {s.label}
              </Btn>
            ))}
            <Btn
              variante={isAuto && reachable ? "plein" : "ghost"}
              className={smallBtn}
              disabled={!reachable}
              aria-pressed={isAuto && reachable}
              aria-busy={pendingScene?.auto || undefined}
              onClick={() => void dispatch(setAuto())}
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

        {/* Sources locales (source web, partage d'écran) */}
        {localSources && <LocalSources {...localSources} />}

        {/* Incrustations */}
        <div className="flex flex-col gap-2.5 border-t border-line pt-3">
          <div className="text-[0.76rem] font-semibold uppercase tracking-[0.1em] text-green">
            {t.regie.overlays}
          </div>

          {/* QR code */}
          <div className="flex flex-wrap items-center gap-1.5" aria-busy={qrBusy || undefined}>
            <EyeBtn
              visible={overlays.qr.visible}
              label={`${overlays.qr.visible ? t.regie.hide : t.regie.show} — ${t.regie.qr}`}
              onClick={() => overlayCmd("qr", "toggle")}
            />
            <span className="min-w-[115px] text-[0.9rem] font-semibold text-ink">{t.regie.qr}</span>
            <input
              type="url"
              value={drafts.qr.url}
              onChange={(e) => qrDraft({ url: e.target.value })}
              placeholder={t.regie.qrUrl}
              maxLength={512}
              className={`${inputCls} min-w-[170px] flex-1`}
            />
            <input
              type="text"
              value={drafts.qr.label}
              onChange={(e) => qrDraft({ label: e.target.value })}
              placeholder={t.regie.qrLabel}
              maxLength={60}
              className={`${inputCls} min-w-[120px] flex-1`}
            />
            <select
              value={drafts.qr.corner}
              onChange={(e) => qrDraft({ corner: e.target.value as OverlayCorner })}
              aria-label={t.regie.qr}
              className={inputCls}
            >
              {CORNERS.map((c) => (
                <option key={c} value={c}>
                  {t.regie.corners[c]}
                </option>
              ))}
            </select>
            <Btn variante="ghost" className={smallBtn} onClick={() => overlayCmd("qr", "apply")}>
              {t.regie.apply}
            </Btn>
          </div>

          {/* Bandeau / Annonce */}
          <div className="flex flex-wrap items-center gap-1.5 border-t border-line pt-2.5" aria-busy={bannerBusy || undefined}>
            <EyeBtn
              visible={overlays.banner.visible}
              label={`${overlays.banner.visible ? t.regie.hide : t.regie.show} — ${t.regie.banner}`}
              onClick={() => overlayCmd("banner", "toggle")}
            />
            <span className="min-w-[115px] text-[0.9rem] font-semibold text-ink">{t.regie.banner}</span>
            <input
              type="text"
              value={drafts.banner.title}
              onChange={(e) => bannerDraft({ title: e.target.value })}
              placeholder={t.regie.bannerTitle}
              maxLength={120}
              className={`${inputCls} min-w-[170px] flex-1`}
            />
            <input
              type="text"
              value={drafts.banner.subtitle}
              onChange={(e) => bannerDraft({ subtitle: e.target.value })}
              placeholder={t.regie.bannerSubtitle}
              maxLength={160}
              className={`${inputCls} min-w-[140px] flex-1`}
            />
            <Btn variante="ghost" className={smallBtn} onClick={() => overlayCmd("banner", "apply")}>
              {t.regie.apply}
            </Btn>
          </div>

          {/* Logo de la mosquée */}
          <div className="flex items-center gap-1.5 border-t border-line pt-2.5" aria-busy={logoBusy || undefined}>
            <EyeBtn
              visible={overlays.logo.visible}
              label={`${overlays.logo.visible ? t.regie.hide : t.regie.show} — ${t.regie.logo}`}
              onClick={() => overlayCmd("logo", "toggle")}
            />
            <span className="text-[0.9rem] font-semibold text-ink">{t.regie.logo}</span>
          </div>
        </div>
      </div>
    </Card>
  );
}
