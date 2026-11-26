import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StreamKind } from "@core/api/types";
import { meterPosition } from "@core/audio/meter";
import { InputAudioMixer } from "@core/audio/mixer";
import { MuteSync } from "@core/audio/mute-sync";
import { Provider } from "react-redux";
import { formatCountdown, formatWhen } from "@core/kiosk/format";
import { isActive } from "@core/session/machine";
import type { SourceOptions } from "@core/sources/types";
import { Backoff } from "@core/kiosk/backoff";
import { describeMediaError } from "@core/sources/camera";
import { formatBitrate, formatDuration } from "@core/stats";
import type { KioskSnapshot } from "@shared/ipc";
import type { CalibrationView, CaptureSettings } from "@core/capture/settings";
import { normalizeDelay } from "@core/capture/types";
import { useBroadcast, useCapture, useDevices, useHealth, useKeeper, useLevel, useNow, useOverlayLayer, useReporter, useSetupMode } from "../hooks";
import { loadPrefs, savePrefs, webcamDelayOf, webcamPairKey, type Prefs } from "../prefs";
import { intlLocale } from "@core/messages";
import { fill, str } from "../strings";
import { t } from "@core/messages";
import { Brand, Btn, Card, ErrorBox, Field, inputClass, Kicker, StatusPill, Title, type PillKey } from "../ui";
import { bridge } from "../bridge";
import { runControlAction, type ControlContext } from "../control-actions";
import { createStudioStore, muteWarningText, storeControl, useStoreValue } from "../store";
import { toggleMic } from "@core/regie/thunks";
import { useLocalSources } from "../local-sources";
import { RegiePanel } from "../components/RegiePanel";
import { RegiePreviewLayer } from "../components/RegiePreviewLayer";
import { SetupProgramView } from "../components/SetupProgramView";
import { IDLE_LIMIT_MS } from "@core/setup/view";
import { overlaysKey } from "@core/setup/overlay-layer";
import type { RegieLiveView } from "../regie-preview";
import { HealthPanel } from "./HealthPanel";
import { ProjectorPanel } from "./ProjectorPanel";
import { SettingsPanel } from "./SettingsPanel";

const kindLabel = (k: StreamKind) => str.live[k];

export function StudioScreen({ kiosk }: { kiosk: KioskSnapshot }) {
  const { session: live, source, composited, compositor, audioMix, snapshot } = useBroadcast();
  const { state, stats } = snapshot;
  const active = isActive(state);
  // Quality chosen for the mosque in the back office: capture size and rate, uplink ceiling (next connection).
  const profile = kiosk.stream;
  useEffect(() => {
    compositor.setProfile(profile);
    live.setConnectOptions({ maxVideoKbps: profile.uplinkKbps, maxHeight: profile.height, maxFps: profile.fps });
  }, [compositor, live, profile]);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [captureError, setCaptureError] = useState("");
  const [captureTry, setCaptureTry] = useState(0);
  const { cameras, microphones } = useDevices(stream);
  const level = useLevel(stream);
  // Incoming-audio mute: tracks are enabled/disabled live, without touching the transport.
  const mixer = useMemo(() => new InputAudioMixer(), []);
  useEffect(() => {
    // The microphone itself is what the mute acts on: with the mix on air, a muted microphone is silent in the mix while
    // the sound of the screen and of the page goes on.
    if (stream) mixer.mix([composited.rawStream ?? stream]);
  }, [mixer, composited, stream]);
  useEffect(() => () => mixer.dispose(), [mixer]);
  // Mute and restore apply here at once; the orchestrator mirrors the value (best effort, retries) for the web Régie.
  // One Redux store holds the Régie and the microphone for the panel, the shortcuts and the local API.
  const muteSync = useMemo(() => new MuteSync(mixer, (m) => bridge.regie.setMute(m)), [mixer]);
  const regieStore = useMemo(() => createStudioStore(muteSync), [muteSync]);
  const mic = useStoreValue(regieStore, (s) => s.regie.mic);
  const toggleMute = () => void regieStore.dispatch(toggleMic());
  // Shortcuts and the local API: the main process asks this window to run an action; the answer says what the screen shows now.
  const controlContext = useRef<ControlContext | null>(null);
  useEffect(
    () =>
      window.studio.control.onRequest((request) =>
        controlContext.current ? runControlAction(request, controlContext.current) : { ok: false, code: "ui_unavailable", message: t("control.uiUnavailable") },
      ),
    [],
  );
  const now = useNow(true);
  const video = useRef<HTMLVideoElement>(null);
  const [regieView, setRegieView] = useState<RegieLiveView | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmUnpair, setConfirmUnpair] = useState(false);
  const [manualError, setManualError] = useState("");
  const [starting, setStarting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Setup mode: the orchestrator's real programme next to the local monitor (see components/SetupProgramView).
  const setup = useSetupMode();
  // The server's own overlay layer over the local monitor; refetched at once on any overlay change.
  const overlayLayer = useOverlayLayer(regieView !== null, overlaysKey(regieView?.overlays), setup.wanted ? "setup" : "live");

  const update = (patch: Partial<Prefs>) =>
    setPrefs((p) => {
      const next = { ...p, ...patch };
      savePrefs(next);
      return next;
    });

  // Web source and screen share: state held here, controls shown in the Régie panel, media mixed by the compositor.
  const persistBrowser = useCallback((b: Prefs["browserSource"]) => {
    setPrefs((p) => {
      if (JSON.stringify(p.browserSource) === JSON.stringify(b)) return p;
      const next = { ...p, browserSource: b };
      savePrefs(next);
      return next;
    });
  }, []);
  const persistScreen = useCallback((s: Prefs["lastScreen"]) => {
    setPrefs((p) => {
      const next = { ...p, lastScreen: s };
      savePrefs(next);
      return next;
    });
  }, []);
  const persistAudio = useCallback((m: Prefs["audioMix"]) => {
    setPrefs((p) => {
      if (JSON.stringify(p.audioMix) === JSON.stringify(m)) return p;
      const next = { ...p, audioMix: m };
      savePrefs(next);
      return next;
    });
  }, []);
  const local = useLocalSources({
    compositor,
    source,
    mix: audioMix,
    browser: { saved: prefs.browserSource, onPersist: persistBrowser },
    screen: { saved: prefs.lastScreen, onPersist: persistScreen },
    audio: { saved: prefs.audioMix, onPersist: persistAudio },
  });

  useEffect(() => {
    controlContext.current = {
      ...storeControl(regieStore),
      browser: local.control.browser,
      screen: local.control.screen,
    };
  });

  const { view: capture, audioInputs, refreshAudioInputs } = useCapture();
  const ipMode = capture?.settings.sourceKind === "ip-camera";
  const rtspUrl = capture?.settings.rtspUrl ?? "";
  const audioDevice = capture?.settings.audioDevice ?? "";
  const webcamDelay = webcamDelayOf(prefs);
  const [webcamCalibration, setWebcamCalibration] = useState<CalibrationView>({ status: "idle" });
  const setWebcamDelay = (ms: number) => {
    const delayMs = normalizeDelay(ms);
    source.syncOf("camera")?.setAudioDelay(delayMs);
    update({ webcamDelays: { ...prefs.webcamDelays, [webcamPairKey(prefs)]: delayMs } });
  };
  const calibrateWebcam = async () => {
    const sync = source.syncOf("camera");
    if (!sync) return;
    const seconds = 10;
    setWebcamCalibration({ status: "running", seconds });
    const result = await sync.calibrate(seconds);
    if (result.ok) setWebcamDelay(result.delayMs);
    setWebcamCalibration({ status: "done", result, at: Date.now() });
  };
  const sourceOptions = useMemo<SourceOptions>(
    () => ({
      sourceKind: local.screenActive ? "screen" : ipMode ? "ip-camera" : "camera",
      screen: local.screenActive ? { sourceId: local.screenSourceId, includeMic: true, systemAudio: local.screenSystemAudio } : undefined,
      ipCamera: ipMode ? { rtspUrl, audioDevice } : undefined,
      videoDeviceId: prefs.videoDeviceId || undefined,
      audioDeviceId: prefs.audioDeviceId || undefined,
      audio: prefs.audio,
      audioDelayMs: ipMode ? undefined : webcamDelay,
      video: { width: profile.width, height: profile.height, frameRate: profile.fps },
    }),
    [profile, local.screenActive, local.screenSourceId, local.screenSystemAudio, ipMode, rtspUrl, audioDevice, prefs.videoDeviceId, prefs.audioDeviceId, prefs.audio, webcamDelay],
  );
  const setCaptureSettings = (patch: Partial<CaptureSettings>) => {
    if (capture) void window.studio.capture.setSettings({ ...capture.settings, ...patch });
  };

  // Preview (and arming): the same capture is then used for the broadcast. Camera missing: retry with bounded growing delays.
  const captureBackoff = useRef(new Backoff({ baseMs: 3_000, maxMs: 60_000, jitter: 0.2 }));
  useEffect(() => {
    // Wait for the source choice (held by the main process) before opening anything.
    if (active || !capture) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    composited
      .acquire(sourceOptions)
      .then((s) => {
        if (!alive) return;
        captureBackoff.current.reset();
        setCaptureError("");
        setStream(s);
      })
      .catch((e) => {
        if (!alive) return;
        setStream(null);
        // A shared screen that cannot be captured is switched off (back to the camera) instead of retried forever.
        if (sourceOptions.sourceKind === "screen") return local.failScreen(describeMediaError(e));
        setCaptureError(describeMediaError(e));
        timer = setTimeout(() => setCaptureTry((n) => n + 1), captureBackoff.current.next());
      });
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // A re-plugged camera (`cameras.length`) restarts the capture right away, without waiting for the next attempt.
  }, [sourceOptions, active, composited, captureTry, ipMode ? 0 : cameras.length, capture === null]); // eslint-disable-line

  // The stream to send changed (web source or screen shown or hidden): the monitor, level meter and projector follow it.
  useEffect(() => composited.onStreamChange(setStream), [composited]);

  // What the broadcast carries: raw source stream, or the compositor's canvas as soon as a web source or the shared
  // screen is shown. While live, the source is swapped first and the output second, both on the open WHIP connection.
  const previousOptions = useRef(sourceOptions);
  const { browserVisible, screenActive } = local;
  useEffect(() => {
    const demand = { browserVisible, screenActive };
    const changed = previousOptions.current !== sourceOptions;
    previousOptions.current = sourceOptions;
    if (!active || !changed) {
      composited.setDemand(demand);
      return;
    }
    let alive = true;
    live
      .swapSource(sourceOptions)
      .catch((e) => {
        if (sourceOptions.sourceKind === "screen") local.failScreen(describeMediaError(e));
      })
      .finally(() => alive && composited.setDemand(demand));
    return () => {
      alive = false;
    };
  }, [browserVisible, screenActive, sourceOptions, active, live, composited]); // eslint-disable-line

  // The <video> element is mounted again when the setup view opens or closes: attach the capture to the new one.
  useEffect(() => {
    if (video.current) video.current.srcObject = stream;
  }, [stream, setup.wanted]);

  const retry = useKeeper(live, kiosk.wantLive && capture !== null, sourceOptions);
  // With the IP camera, the PC's own devices do not matter: the capture's tracks are what counts.
  const health = useHealth(
    kiosk,
    ipMode ? (stream?.getVideoTracks().length ?? 0) : cameras.length,
    ipMode ? (stream?.getAudioTracks().length ?? 0) : microphones.length,
  );
  useReporter(state, stats.bitrateKbps, kiosk.wantLive, stream, health);

  const elapsed = state.startedAt ? now - state.startedAt : 0;
  const nextSlot = kiosk.nextSlot;
  const armedTime = nextSlot ? new Date(nextSlot.startsAt).toLocaleTimeString(intlLocale(), { hour: "2-digit", minute: "2-digit" }) : "";

  const pill: { key: PillKey; label: string } =
    state.status === "reconnecting"
      ? { key: "reconnecting", label: fill(str.status.reconnecting, { n: state.attempt }) }
      : state.status !== "idle"
        ? { key: state.status, label: str.status[state.status] }
        : kiosk.phase === "armed"
          ? { key: "armed", label: fill(str.status.armed, { time: armedTime }) }
          : kiosk.phase === "onair"
            ? { key: "connecting", label: str.status.connecting }
            : { key: "standby", label: str.status.standby };

  const onAir = kiosk.wantLive || active || state.status === "stopping";
  const liveNow = kiosk.live;
  const canManual = !onAir && prefs.title.trim() !== "" && !starting;

  const startManual = async () => {
    setManualError("");
    setStarting(true);
    const r = await window.studio.kiosk.startManual({ type: prefs.kind, title: prefs.title.trim() });
    setStarting(false);
    if (!r.ok) setManualError(r.message);
  };

  const stop = async () => {
    setConfirmStop(false);
    // Cut here first (the supervisor dismisses this live), then the server is notified.
    await window.studio.kiosk.stopLive();
  };

  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const locked = onAir;
  const conflict = kiosk.conflict?.message ?? (state.errorCode === "conflict" ? state.error : null);
  const since = kiosk.lastSeenAt ? new Date(kiosk.lastSeenAt).toLocaleTimeString(intlLocale(), { hour: "2-digit", minute: "2-digit" }) : "";

  // The local monitor (capture + server overlay layer): one element, shown alone or next to the programme in setup mode.
  const monitor = (
        <div className={`relative aspect-video overflow-hidden rounded-t-[10px] bg-night ${onAir ? "max-h-[calc(100vh-17rem)] min-h-64 w-full" : ""}`}>
          <video ref={video} autoPlay muted playsInline className="size-full object-contain" />
          <RegiePreviewLayer view={regieView} layer={overlayLayer} />
          {!stream && (
            <div className="absolute inset-0 grid place-content-center gap-3 px-6 text-center text-night-muted">
              <p className="m-0">{captureError ? `${captureError} ${str.preview.retry}` : str.preview.empty}</p>
              {captureError === t("media.deniedSystem") && (
                <button type="button" className="mx-auto underline" onClick={() => void window.studio.media.openSettings("microphone")}>
                  {str.preview.openSettings}
                </button>
              )}
            </div>
          )}
          {state.status === "reconnecting" && (
            <p className="absolute inset-x-0 bottom-0 m-0 bg-warn-bg px-4 py-2 text-[0.9rem] text-warn">
              {state.error} {pill.label}
            </p>
          )}
        </div>
  );

  return (
    <div className="min-h-screen">
      <header className="bg-night text-night-ink shadow-[0_1px_0_rgba(0,0,0,0.2)]">
        <div className="mx-auto flex max-w-[1180px] items-center justify-between gap-4 px-6 py-3">
          <div className="flex items-center gap-4">
            <Brand dark />
            <span className="font-serif text-[1.2rem]">{kiosk.mosque?.name}</span>
          </div>
          <div className="flex items-center gap-2 text-[0.9rem]">
            <Btn variante="light" className="min-h-9! px-3! py-1.5!" aria-haspopup="dialog" onClick={() => setSettingsOpen(true)}>
              <span aria-hidden="true">⚙ </span>
              {str.settings.button}
            </Btn>
            {confirmUnpair ? (
              <>
                <span className="text-night-muted">{str.nav.unpairHelp}</span>
                <Btn
                  variante="danger"
                  className="min-h-9! px-3! py-1.5!"
                  onClick={() => {
                    setConfirmUnpair(false);
                    void window.studio.kiosk.unpair();
                  }}
                >
                  {str.nav.yes}
                </Btn>
                <Btn variante="light" className="min-h-9! px-3! py-1.5!" onClick={() => setConfirmUnpair(false)}>
                  {str.nav.no}
                </Btn>
              </>
            ) : (
              <Btn variante="light" className="min-h-9! px-3! py-1.5!" disabled={onAir} onClick={() => setConfirmUnpair(true)}>
                {str.nav.unpair}
              </Btn>
            )}
          </div>
        </div>
      </header>

      <main
        data-onair={onAir || undefined}
        className={`mx-auto grid gap-5 px-6 py-6 ${onAir || setup.wanted ? "max-w-[1700px]" : "max-w-[1180px] lg:grid-cols-[minmax(0,1fr)_360px]"}`}
      >
        <div className="grid content-start gap-4">
          <Card className="p-0!">
            {setup.wanted ? (
              <div className="grid gap-3 p-3 md:grid-cols-2">
                <div className="min-w-0 overflow-hidden rounded-[10px] border border-line">
                  <p className="m-0 px-4.5 py-2 text-[0.78rem] font-semibold uppercase tracking-[0.1em] text-green">{t("setup.local")}</p>
                  {monitor}
                </div>
                <div className="min-w-0 overflow-hidden rounded-[10px] border border-line">
                  <p className="m-0 px-4.5 py-2 text-[0.78rem] font-semibold uppercase tracking-[0.1em] text-green">{t("setup.program")}</p>
                  <SetupProgramView phase={setup.phase} state={setup.state} onPlaying={setup.setPlaying} />
                  {setup.phase === "watching" && !setup.state?.live && <p className="m-0 px-4.5 py-2 text-[0.8rem] text-muted">{t("setup.neutralCamera")}</p>}
                </div>
              </div>
            ) : (
              monitor
            )}
            <div className="px-4.5 py-3">
              {ipMode && capture && (
                <p
                  role="status"
                  className={`m-0 mb-2 text-[0.85rem] ${capture.alert ? "text-live" : capture.state.status === "running" ? "text-green" : "text-warn"}`}
                >
                  <span className="font-semibold">{str.ipCamera.kindIp}</span>
                  {" : "}
                  {capture.alert
                    ? str.ipCamera.alert
                    : capture.state.status === "reconnecting"
                      ? fill(str.ipCamera.state.reconnecting, { n: capture.state.attempt })
                      : str.ipCamera.state[capture.state.status]}
                  {capture.state.status !== "running" && capture.state.lastError ? ` — ${capture.state.lastError}` : ""}
                </p>
              )}
              <div
                role="meter"
                aria-label={str.preview.level}
                aria-valuemin={-60}
                aria-valuemax={0}
                aria-valuenow={Math.round(Math.max(-60, level.rms))}
                className="h-2.5 overflow-hidden rounded-full bg-paper-2"
              >
                <div
                  className="h-full rounded-full transition-[width] duration-75"
                  style={{
                    width: `${meterPosition(level.rms) * 100}%`,
                    background: level.peak > -3 ? "var(--color-live)" : level.peak > -12 ? "var(--color-leaf-2)" : "var(--color-green)",
                  }}
                />
              </div>
              <p className="m-0 mt-1 text-[0.8rem] text-muted">{str.preview.level}</p>
            </div>
          </Card>

          <Card className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <StatusPill status={pill.key} label={pill.label} />
            <Metric label={str.controls.duration} value={state.startedAt ? formatDuration(elapsed) : "—"} />
            <Metric label={str.controls.bitrate} value={state.status === "live" && stats.bitrateKbps ? formatBitrate(stats.bitrateKbps) : "—"} />
            <Metric label={str.controls.latency} value={stats.rttMs !== undefined && state.status === "live" ? `${stats.rttMs} ms` : "—"} />
            <div className="ml-auto">
              {onAir && !confirmStop && (
                <Btn variante="danger" disabled={state.status === "stopping"} onClick={() => setConfirmStop(true)}>
                  {str.stop.button}
                </Btn>
              )}
            </div>
            {confirmStop && (
              <div role="alertdialog" aria-label={str.stop.confirmTitle} className="basis-full rounded-lg bg-err-bg px-4 py-3">
                <p className="m-0 font-semibold text-[#7a1f20]">{str.stop.confirmTitle}</p>
                <p className="m-0 mb-2.5 text-[0.9rem] text-[#7a1f20]">{str.stop.confirmHelp}</p>
                <div className="flex gap-2">
                  <Btn variante="danger" onClick={() => void stop()}>
                    {str.stop.confirm}
                  </Btn>
                  <Btn variante="ghost" onClick={() => setConfirmStop(false)}>
                    {str.stop.keep}
                  </Btn>
                </div>
              </div>
            )}
          </Card>
          <Card className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="min-w-0 flex-1">
              <Kicker>{t("setup.kicker")}</Kicker>
              <p className="m-0 font-serif text-[1.15rem] text-deeper">{t("setup.title")}</p>
              <p className="m-0 mt-1 text-[0.85rem] text-muted">{setup.state?.live ? t("setup.hintLive") : t("setup.hint")}</p>
              {setup.idleClosed && !setup.wanted && (
                <p role="status" className="m-0 mt-2 text-[0.85rem] text-warn">
                  {t("setup.idleClosed", { min: Math.round(IDLE_LIMIT_MS / 60_000) })}
                </p>
              )}
            </div>
            {setup.wanted ? (
              <Btn variante="ghost" onClick={setup.close}>
                {t("setup.close")}
              </Btn>
            ) : (
              <Btn onClick={setup.open}>{t("setup.open")}</Btn>
            )}
          </Card>
          {/* Remounted on a mode change: the panel reads the rehearsal's scenes and overlays, or the live's again.
              While the setup mode is being entered it is not mounted: its first read would still address the live. */}
          {(!setup.wanted || setup.state) && (
            <Provider store={regieStore}>
              <RegiePanel key={setup.wanted ? "setup" : "live"} onLiveChange={setRegieView} localSources={local.props} audio={{ level, muted: mic.muted, onToggleMute: toggleMute, error: muteWarningText(mic) }} />
            </Provider>
          )}
          <ProjectorPanel stream={stream} onAir={onAir} prefs={prefs} setPrefs={update} />
          {kiosk.stopPending && <p className="m-0 text-[0.85rem] text-muted">{str.stop.pending}</p>}
          {state.status === "error" && state.error && state.errorCode !== "conflict" && <ErrorBox>{state.error}</ErrorBox>}
          {conflict && (
            <ErrorBox>
              {conflict}
              {retry && ` ${fill(str.box.retryIn, { t: formatCountdown(retry.at - now) })} ${str.box.conflictLater}`}
            </ErrorBox>
          )}
          {!kiosk.online && (
            <p role="status" className="m-0 rounded-lg bg-warn-bg px-3 py-2 text-[0.9rem] text-warn">
              {fill(str.box.offline, { since: since ? fill(str.box.since, { t: since }) : "" })}
            </p>
          )}
          {kiosk.resuming && <p className="m-0 rounded-lg bg-warn-bg px-3 py-2 text-[0.9rem] text-warn">{str.box.resuming}</p>}
          {kiosk.update && (
            <p className="m-0 rounded-lg bg-paper-2 px-3 py-2 text-[0.9rem] text-muted">
              {kiosk.update.downloading !== null
                ? fill(str.box.updateDownloading, { v: kiosk.update.version, p: kiosk.update.downloading })
                : kiosk.update.waiting
                ? fill(str.box.updateWaiting, { v: kiosk.update.version, why: kiosk.update.waiting })
                : fill(str.box.updateReady, { v: kiosk.update.version })}
            </p>
          )}
        </div>

        <aside className="grid content-start gap-4">
          <Card>
            <Kicker>{str.box.kicker}</Kicker>
            <Title>{fill(str.box.pairedTo, { name: kiosk.mosque?.name ?? "" })}</Title>
            <dl className="m-0 grid gap-2 text-[0.92rem]">
              {liveNow ? (
                <div>
                  <dt className="text-[0.78rem] font-semibold uppercase tracking-[0.1em] text-green">
                    {liveNow.source === "manual" ? str.box.sourceManual : str.box.sourceSchedule}
                  </dt>
                  <dd className="m-0 font-semibold text-deeper">{fill(str.box.nextLine, { kind: kindLabel(liveNow.type), title: liveNow.title })}</dd>
                </div>
              ) : (
                <div>
                  <dt className="text-[0.78rem] font-semibold uppercase tracking-[0.1em] text-green">{str.box.next}</dt>
                  <dd className="m-0">
                    {nextSlot ? (
                      <>
                        <span className="font-semibold text-deeper">{fill(str.box.nextLine, { kind: kindLabel(nextSlot.type), title: nextSlot.title })}</span>
                        <br />
                        <span className="text-muted">{formatWhen(nextSlot.startsAt, now)}</span>
                      </>
                    ) : (
                      <span className="text-muted">{str.box.nextNone}</span>
                    )}
                  </dd>
                </div>
              )}
            </dl>
            {!kiosk.persistent && <p className="mb-0 mt-3 text-[0.82rem] text-muted">{str.box.noVault}</p>}
          </Card>

          <Card>
            <Kicker>{str.manual.kicker}</Kicker>
            <Title>{str.manual.title}</Title>
            <p className="mb-3 mt-0 text-[0.85rem] text-muted">{onAir ? str.manual.busy : str.manual.hint}</p>
            <div className="grid gap-3.5">
              <div role="radiogroup" aria-label={str.live.kind} className="grid grid-cols-3 gap-1 rounded-[9px] bg-paper-2 p-1">
                {(["khutba", "dars", "conference"] as StreamKind[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={prefs.kind === k}
                    disabled={locked}
                    onClick={() => update({ kind: k })}
                    className={`min-h-9 cursor-pointer rounded-[7px] px-3 font-semibold disabled:cursor-not-allowed ${
                      prefs.kind === k ? "bg-deep text-white" : "text-deep hover:bg-white/60"
                    }`}
                  >
                    {str.live[k]}
                  </button>
                ))}
              </div>
              <Field label={str.live.titleField}>
                <input
                  value={prefs.title}
                  placeholder={str.live.titlePlaceholder}
                  autoComplete="off"
                  disabled={locked}
                  onChange={(e) => update({ title: e.target.value })}
                  className={inputClass}
                />
              </Field>
              {manualError && <ErrorBox>{manualError}</ErrorBox>}
              <Btn disabled={!canManual} onClick={() => void startManual()}>
                {starting ? str.manual.starting : str.manual.start}
              </Btn>
              {!onAir && prefs.title.trim() === "" && <p className="m-0 text-[0.82rem] text-muted">{str.manual.needTitle}</p>}
            </div>
          </Card>

          <HealthPanel items={health} />
        </aside>
      </main>
      {settingsOpen && (
        <SettingsPanel
          prefs={prefs}
          cameras={cameras}
          microphones={microphones}
          locked={locked}
          onChange={update}
          onClose={closeSettings}
          capture={capture}
          audioInputs={audioInputs}
          onCaptureSettings={setCaptureSettings}
          onRefreshAudioInputs={refreshAudioInputs}
          onCaptureDelay={(ms) => void window.studio.capture.setDelay(ms)}
          onCalibrate={() => void window.studio.capture.calibrate()}
          webcam={{ delayMs: webcamDelay, calibration: webcamCalibration, canCalibrate: stream !== null && !ipMode, onDelay: setWebcamDelay, onCalibrate: () => void calibrateWebcam() }}
        />
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="m-0 text-[0.75rem] font-semibold uppercase leading-none tracking-[0.12em] text-green">{label}</p>
      <p className="m-0 mt-1 font-serif text-[1.4rem] leading-none text-deeper tabular-nums">{value}</p>
    </div>
  );
}
