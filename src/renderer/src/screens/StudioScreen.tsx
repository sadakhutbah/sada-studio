import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionInfo, StreamKind } from "@core/api/types";
import { meterPosition } from "@core/audio/meter";
import { canStart, isActive } from "@core/session/machine";
import type { AudioSettings, SourceOptions } from "@core/sources/types";
import { describeMediaError } from "@core/sources/camera";
import { formatBitrate, formatDuration } from "@core/stats";
import { ipcApi } from "../bridge";
import { useBroadcast, useDevices, useLevel, useNow } from "../hooks";
import { loadPrefs, savePrefs, type Prefs } from "../prefs";
import { fill, fr } from "../strings";
import { Brand, Btn, Card, ErrorBox, Field, inputClass, Kicker, selectClass, StatusPill, Title } from "../ui";

export function StudioScreen({
  session,
  onSwitchMosque,
  onLogout,
}: {
  session: SessionInfo;
  onSwitchMosque: () => void;
  onLogout: () => void;
}) {
  const { session: live, source, snapshot } = useBroadcast();
  const { state, stats } = snapshot;
  const active = isActive(state);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [captureError, setCaptureError] = useState("");
  const { cameras, microphones } = useDevices(stream);
  const level = useLevel(stream);
  const now = useNow(state.status === "live" || state.status === "reconnecting");
  const video = useRef<HTMLVideoElement>(null);

  const mosque = session.mosque!;
  const canLive = session.user.permissions.includes("live");
  const update = (patch: Partial<Prefs>) =>
    setPrefs((p) => {
      const next = { ...p, ...patch };
      savePrefs(next);
      return next;
    });

  const sourceOptions = useMemo<SourceOptions>(
    () => ({
      videoDeviceId: prefs.videoDeviceId || undefined,
      audioDeviceId: prefs.audioDeviceId || undefined,
      audio: prefs.audio,
    }),
    [prefs.videoDeviceId, prefs.audioDeviceId, prefs.audio],
  );

  // Aperçu : la même capture sert ensuite à la diffusion (la source rend le même flux tant que les réglages sont identiques).
  useEffect(() => {
    if (active) return;
    let alive = true;
    source
      .acquire(sourceOptions)
      .then((s) => {
        if (!alive) return;
        setCaptureError("");
        setStream(s);
      })
      .catch((e) => {
        if (!alive) return;
        setStream(null);
        setCaptureError(describeMediaError(e));
      });
    return () => {
      alive = false;
    };
  }, [sourceOptions, active, source]);

  useEffect(() => {
    if (video.current) video.current.srcObject = stream;
  }, [stream]);

  useEffect(() => {
    void window.studio.keepAwake(active);
  }, [active]);

  const start = () => {
    void ipcApi.announce({ kind: prefs.kind, title: prefs.title });
    void live.start(sourceOptions);
  };

  const setAudio = (k: keyof AudioSettings, v: boolean) => update({ audio: { ...prefs.audio, [k]: v } });
  const elapsed = state.startedAt ? now - state.startedAt : 0;
  const statusLabel =
    state.status === "reconnecting" ? fill(fr.status.reconnecting, { n: state.attempt }) : fr.status[state.status];
  const locked = active || state.status === "stopping";

  return (
    <div className="min-h-screen">
      <header className="bg-night text-night-ink shadow-[0_1px_0_rgba(0,0,0,0.2)]">
        <div className="mx-auto flex max-w-[1180px] items-center justify-between gap-4 px-6 py-3">
          <div className="flex items-center gap-4">
            <Brand dark />
            <span className="font-serif text-[1.2rem]">{mosque.name}</span>
          </div>
          <div className="flex items-center gap-2 text-[0.9rem]">
            <span className="text-night-muted">{session.user.name}</span>
            {session.mosques.length > 1 && (
              <Btn variante="light" className="min-h-9! px-3! py-1.5!" disabled={locked} onClick={onSwitchMosque}>
                {fr.nav.switch}
              </Btn>
            )}
            <Btn variante="light" className="min-h-9! px-3! py-1.5!" disabled={locked} onClick={onLogout}>
              {fr.nav.logout}
            </Btn>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1180px] gap-5 px-6 py-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="grid content-start gap-4">
          <Card className="p-0!">
            <div className="relative aspect-video overflow-hidden rounded-t-[10px] bg-night">
              <video ref={video} autoPlay muted playsInline className="size-full object-contain" />
              {!stream && (
                <p className="absolute inset-0 m-0 grid place-items-center px-6 text-center text-night-muted">
                  {captureError || fr.preview.empty}
                </p>
              )}
              {state.status === "reconnecting" && (
                <p className="absolute inset-x-0 bottom-0 m-0 bg-warn-bg px-4 py-2 text-[0.9rem] text-warn">
                  {state.error} {statusLabel}
                </p>
              )}
            </div>
            <div className="px-4.5 py-3">
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
            <StatusPill status={state.status} label={statusLabel} />
            <Metric label={fr.controls.duration} value={state.startedAt ? formatDuration(elapsed) : "—"} />
            <Metric label={fr.controls.bitrate} value={state.status === "live" && stats.bitrateKbps ? formatBitrate(stats.bitrateKbps) : "—"} />
            <Metric label={fr.controls.latency} value={stats.rttMs !== undefined && state.status === "live" ? `${stats.rttMs} ms` : "—"} />
            <div className="ml-auto">
              {active || state.status === "stopping" ? (
                <Btn variante="danger" disabled={state.status === "stopping"} onClick={() => void live.stop()}>
                  {fr.controls.stop}
                </Btn>
              ) : (
                <Btn disabled={!stream || !canLive || !canStart(state)} onClick={start}>
                  {fr.controls.start}
                </Btn>
              )}
            </div>
          </Card>
          {state.status === "error" && state.error && <ErrorBox>{state.error}</ErrorBox>}
          {!canLive && <ErrorBox>{fr.live.noRight}</ErrorBox>}
        </div>

        <aside className="grid content-start gap-4">
          <Card>
            <Kicker>{fr.live.kicker}</Kicker>
            <Title>{fr.live.title}</Title>
            <div className="grid gap-3.5">
              <div role="radiogroup" aria-label={fr.live.kind} className="grid grid-cols-2 gap-1 rounded-[9px] bg-paper-2 p-1">
                {(["khutba", "dars"] as StreamKind[]).map((k) => (
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
              <Field label={fr.live.titleField} help={fr.live.titleHelp}>
                <input
                  value={prefs.title}
                  placeholder={fr.live.titlePlaceholder}
                  disabled={locked}
                  onChange={(e) => update({ title: e.target.value })}
                  className={inputClass}
                />
              </Field>
            </div>
          </Card>

          <Card>
            <Kicker>{fr.sources.kicker}</Kicker>
            <div className="grid gap-3.5">
              <Field label={fr.sources.camera}>
                <select
                  value={prefs.videoDeviceId}
                  disabled={locked}
                  onChange={(e) => update({ videoDeviceId: e.target.value })}
                  className={selectClass}
                >
                  <option value="">{cameras.length ? fr.sources.default : fr.sources.none}</option>
                  {cameras.map((d, i) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `${fr.sources.camera} ${i + 1}`}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={fr.sources.microphone}>
                <select
                  value={prefs.audioDeviceId}
                  disabled={locked}
                  onChange={(e) => update({ audioDeviceId: e.target.value })}
                  className={selectClass}
                >
                  <option value="">{microphones.length ? fr.sources.default : fr.sources.noMic}</option>
                  {microphones.map((d, i) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `${fr.sources.microphone} ${i + 1}`}
                    </option>
                  ))}
                </select>
              </Field>
              {locked && <p className="m-0 text-[0.82rem] text-muted">{fr.sources.lockedLive}</p>}
            </div>
          </Card>

          <Card>
            <Kicker>{fr.audio.kicker}</Kicker>
            <p className="mb-3 mt-0 text-[0.85rem] text-muted">{fr.audio.hint}</p>
            <div className="grid gap-2">
              {(["echoCancellation", "noiseSuppression", "autoGainControl"] as const).map((k) => (
                <label key={k} className="flex items-center gap-2.5 text-[0.95rem]">
                  <input type="checkbox" checked={prefs.audio[k]} disabled={locked} onChange={(e) => setAudio(k, e.target.checked)} />
                  {fr.audio[k]}
                </label>
              ))}
            </div>
          </Card>
        </aside>
      </main>
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
