import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StreamKind } from "@core/api/types";
import { meterPosition } from "@core/audio/meter";
import { formatCountdown, formatWhen } from "@core/kiosk/format";
import { isActive } from "@core/session/machine";
import type { SourceOptions } from "@core/sources/types";
import { Backoff } from "@core/kiosk/backoff";
import { describeMediaError } from "@core/sources/camera";
import { formatBitrate, formatDuration } from "@core/stats";
import type { KioskSnapshot } from "@shared/ipc";
import type { CaptureSettings } from "@core/capture/settings";
import { useBroadcast, useCapture, useDevices, useHealth, useKeeper, useLevel, useNow, useReporter } from "../hooks";
import { loadPrefs, savePrefs, type Prefs } from "../prefs";
import { fill, fr } from "../strings";
import { Brand, Btn, Card, ErrorBox, Field, inputClass, Kicker, StatusPill, Title, type PillKey } from "../ui";
import { HealthPanel } from "./HealthPanel";
import { SettingsPanel } from "./SettingsPanel";

const kindLabel = (k: StreamKind) => fr.live[k];

export function StudioScreen({ kiosk }: { kiosk: KioskSnapshot }) {
  const { session: live, source, snapshot } = useBroadcast();
  const { state, stats } = snapshot;
  const active = isActive(state);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [captureError, setCaptureError] = useState("");
  const [captureTry, setCaptureTry] = useState(0);
  const { cameras, microphones } = useDevices(stream);
  const level = useLevel(stream);
  const now = useNow(true);
  const video = useRef<HTMLVideoElement>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmUnpair, setConfirmUnpair] = useState(false);
  const [manualError, setManualError] = useState("");
  const [starting, setStarting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const update = (patch: Partial<Prefs>) =>
    setPrefs((p) => {
      const next = { ...p, ...patch };
      savePrefs(next);
      return next;
    });

  const { view: capture, audioInputs, refreshAudioInputs } = useCapture();
  const ipMode = capture?.settings.sourceKind === "ip-camera";
  const rtspUrl = capture?.settings.rtspUrl ?? "";
  const audioDevice = capture?.settings.audioDevice ?? "";
  const sourceOptions = useMemo<SourceOptions>(
    () => ({
      sourceKind: ipMode ? "ip-camera" : "camera",
      ipCamera: ipMode ? { rtspUrl, audioDevice } : undefined,
      videoDeviceId: prefs.videoDeviceId || undefined,
      audioDeviceId: prefs.audioDeviceId || undefined,
      audio: prefs.audio,
    }),
    [ipMode, rtspUrl, audioDevice, prefs.videoDeviceId, prefs.audioDeviceId, prefs.audio],
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
    source
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
        setCaptureError(describeMediaError(e));
        timer = setTimeout(() => setCaptureTry((n) => n + 1), captureBackoff.current.next());
      });
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // A re-plugged camera (`cameras.length`) restarts the capture right away, without waiting for the next attempt.
  }, [sourceOptions, active, source, captureTry, ipMode ? 0 : cameras.length, capture === null]); // eslint-disable-line

  useEffect(() => {
    if (video.current) video.current.srcObject = stream;
  }, [stream]);

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
  const armedTime = nextSlot ? new Date(nextSlot.startsAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : "";

  const pill: { key: PillKey; label: string } =
    state.status === "reconnecting"
      ? { key: "reconnecting", label: fill(fr.status.reconnecting, { n: state.attempt }) }
      : state.status !== "idle"
        ? { key: state.status, label: fr.status[state.status] }
        : kiosk.phase === "armed"
          ? { key: "armed", label: fill(fr.status.armed, { time: armedTime }) }
          : kiosk.phase === "onair"
            ? { key: "connecting", label: fr.status.connecting }
            : { key: "standby", label: fr.status.standby };

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
  const since = kiosk.lastSeenAt ? new Date(kiosk.lastSeenAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : "";

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
              {fr.settings.button}
            </Btn>
            {confirmUnpair ? (
              <>
                <span className="text-night-muted">{fr.nav.unpairHelp}</span>
                <Btn
                  variante="danger"
                  className="min-h-9! px-3! py-1.5!"
                  onClick={() => {
                    setConfirmUnpair(false);
                    void window.studio.kiosk.unpair();
                  }}
                >
                  {fr.nav.yes}
                </Btn>
                <Btn variante="light" className="min-h-9! px-3! py-1.5!" onClick={() => setConfirmUnpair(false)}>
                  {fr.nav.no}
                </Btn>
              </>
            ) : (
              <Btn variante="light" className="min-h-9! px-3! py-1.5!" disabled={onAir} onClick={() => setConfirmUnpair(true)}>
                {fr.nav.unpair}
              </Btn>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1180px] gap-5 px-6 py-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="grid content-start gap-4">
          <Card className="p-0!">
            <div className="relative aspect-video overflow-hidden rounded-t-[10px] bg-night">
              <video ref={video} autoPlay muted playsInline className="size-full object-contain" />
              {!stream && (
                <p className="absolute inset-0 m-0 grid place-items-center px-6 text-center text-night-muted">
                  {captureError ? `${captureError} ${fr.preview.retry}` : fr.preview.empty}
                </p>
              )}
              {state.status === "reconnecting" && (
                <p className="absolute inset-x-0 bottom-0 m-0 bg-warn-bg px-4 py-2 text-[0.9rem] text-warn">
                  {state.error} {pill.label}
                </p>
              )}
            </div>
            <div className="px-4.5 py-3">
              {ipMode && capture && (
                <p
                  role="status"
                  className={`m-0 mb-2 text-[0.85rem] ${capture.alert ? "text-live" : capture.state.status === "running" ? "text-green" : "text-warn"}`}
                >
                  <span className="font-semibold">{fr.ipCamera.kindIp}</span>
                  {" : "}
                  {capture.alert
                    ? fr.ipCamera.alert
                    : capture.state.status === "reconnecting"
                      ? fill(fr.ipCamera.state.reconnecting, { n: capture.state.attempt })
                      : fr.ipCamera.state[capture.state.status]}
                  {capture.state.status !== "running" && capture.state.lastError ? ` — ${capture.state.lastError}` : ""}
                </p>
              )}
              <div
                role="meter"
                aria-label={fr.preview.level}
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
              <p className="m-0 mt-1 text-[0.8rem] text-muted">{fr.preview.level}</p>
            </div>
          </Card>

          <Card className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <StatusPill status={pill.key} label={pill.label} />
            <Metric label={fr.controls.duration} value={state.startedAt ? formatDuration(elapsed) : "—"} />
            <Metric label={fr.controls.bitrate} value={state.status === "live" && stats.bitrateKbps ? formatBitrate(stats.bitrateKbps) : "—"} />
            <Metric label={fr.controls.latency} value={stats.rttMs !== undefined && state.status === "live" ? `${stats.rttMs} ms` : "—"} />
            <div className="ml-auto">
              {onAir && !confirmStop && (
                <Btn variante="danger" disabled={state.status === "stopping"} onClick={() => setConfirmStop(true)}>
                  {fr.stop.button}
                </Btn>
              )}
            </div>
            {confirmStop && (
              <div role="alertdialog" aria-label={fr.stop.confirmTitle} className="basis-full rounded-lg bg-err-bg px-4 py-3">
                <p className="m-0 font-semibold text-[#7a1f20]">{fr.stop.confirmTitle}</p>
                <p className="m-0 mb-2.5 text-[0.9rem] text-[#7a1f20]">{fr.stop.confirmHelp}</p>
                <div className="flex gap-2">
                  <Btn variante="danger" onClick={() => void stop()}>
                    {fr.stop.confirm}
                  </Btn>
                  <Btn variante="ghost" onClick={() => setConfirmStop(false)}>
                    {fr.stop.keep}
                  </Btn>
                </div>
              </div>
            )}
          </Card>
          {kiosk.stopPending && <p className="m-0 text-[0.85rem] text-muted">{fr.stop.pending}</p>}
          {state.status === "error" && state.error && state.errorCode !== "conflict" && <ErrorBox>{state.error}</ErrorBox>}
          {conflict && (
            <ErrorBox>
              {conflict}
              {retry && ` ${fill(fr.box.retryIn, { t: formatCountdown(retry.at - now) })} ${fr.box.conflictLater}`}
            </ErrorBox>
          )}
          {!kiosk.online && (
            <p role="status" className="m-0 rounded-lg bg-warn-bg px-3 py-2 text-[0.9rem] text-warn">
              {fill(fr.box.offline, { since: since ? fill(fr.box.since, { t: since }) : "" })}
            </p>
          )}
          {kiosk.resuming && <p className="m-0 rounded-lg bg-warn-bg px-3 py-2 text-[0.9rem] text-warn">{fr.box.resuming}</p>}
          {kiosk.update && (
            <p className="m-0 rounded-lg bg-paper-2 px-3 py-2 text-[0.9rem] text-muted">
              {kiosk.update.downloading !== null
                ? fill(fr.box.updateDownloading, { v: kiosk.update.version, p: kiosk.update.downloading })
                : kiosk.update.waiting
                ? fill(fr.box.updateWaiting, { v: kiosk.update.version, why: kiosk.update.waiting })
                : fill(fr.box.updateReady, { v: kiosk.update.version })}
            </p>
          )}
        </div>

        <aside className="grid content-start gap-4">
          <Card>
            <Kicker>{fr.box.kicker}</Kicker>
            <Title>{fill(fr.box.pairedTo, { name: kiosk.mosque?.name ?? "" })}</Title>
            <dl className="m-0 grid gap-2 text-[0.92rem]">
              {liveNow ? (
                <div>
                  <dt className="text-[0.78rem] font-semibold uppercase tracking-[0.1em] text-green">
                    {liveNow.source === "manual" ? fr.box.sourceManual : fr.box.sourceSchedule}
                  </dt>
                  <dd className="m-0 font-semibold text-deeper">{fill(fr.box.nextLine, { kind: kindLabel(liveNow.type), title: liveNow.title })}</dd>
                </div>
              ) : (
                <div>
                  <dt className="text-[0.78rem] font-semibold uppercase tracking-[0.1em] text-green">{fr.box.next}</dt>
                  <dd className="m-0">
                    {nextSlot ? (
                      <>
                        <span className="font-semibold text-deeper">{fill(fr.box.nextLine, { kind: kindLabel(nextSlot.type), title: nextSlot.title })}</span>
                        <br />
                        <span className="text-muted">{formatWhen(nextSlot.startsAt, now)}</span>
                      </>
                    ) : (
                      <span className="text-muted">{fr.box.nextNone}</span>
                    )}
                  </dd>
                </div>
              )}
            </dl>
            {!kiosk.persistent && <p className="mb-0 mt-3 text-[0.82rem] text-muted">{fr.box.noVault}</p>}
          </Card>

          <Card>
            <Kicker>{fr.manual.kicker}</Kicker>
            <Title>{fr.manual.title}</Title>
            <p className="mb-3 mt-0 text-[0.85rem] text-muted">{onAir ? fr.manual.busy : fr.manual.hint}</p>
            <div className="grid gap-3.5">
              <div role="radiogroup" aria-label={fr.live.kind} className="grid grid-cols-3 gap-1 rounded-[9px] bg-paper-2 p-1">
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
                    {fr.live[k]}
                  </button>
                ))}
              </div>
              <Field label={fr.live.titleField}>
                <input
                  value={prefs.title}
                  placeholder={fr.live.titlePlaceholder}
                  autoComplete="off"
                  disabled={locked}
                  onChange={(e) => update({ title: e.target.value })}
                  className={inputClass}
                />
              </Field>
              {manualError && <ErrorBox>{manualError}</ErrorBox>}
              <Btn disabled={!canManual} onClick={() => void startManual()}>
                {starting ? fr.manual.starting : fr.manual.start}
              </Btn>
              {!onAir && prefs.title.trim() === "" && <p className="m-0 text-[0.82rem] text-muted">{fr.manual.needTitle}</p>}
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
