import { useState } from "react";
import { isRtspUrl, type CalibrationView, type CaptureSettings, type CaptureView } from "@core/capture/settings";
import { t } from "@core/messages";
import { fill, fr } from "../strings";
import { Btn, Card, Field, inputClass, Kicker, selectClass } from "../ui";

type Props = {
  view: CaptureView;
  devices: string[];
  locked: boolean;
  onSettings: (patch: Partial<CaptureSettings>) => void;
  onRefreshDevices: () => void;
  onDelay: (ms: number) => void;
  onCalibrate: () => void;
};

/** Message of a finished calibration run, in the UI language. */
export function describeCalibration(c: CalibrationView): { ok: boolean; text: string } | null {
  if (c.status !== "done") return null;
  const r = c.result;
  if (r.ok) {
    return r.audioBehind
      ? { ok: false, text: t("capture.calib.audioBehind") }
      : { ok: true, text: fill(fr.ipCamera.calibrated, { gap: r.gapMs, delay: r.delayMs }) };
  }
  if (r.reason === "no-audio") return { ok: false, text: t("capture.calib.noAudio") };
  if (r.reason === "no-video") return { ok: false, text: t("capture.calib.noVideo") };
  if (r.reason === "no-clap") return { ok: false, text: t("capture.calib.noClap") };
  return { ok: false, text: t("capture.calib.ffmpeg", { detail: "detail" in r ? r.detail : "" }) };
}

const stateLabel = (v: CaptureView) => {
  const s = v.state;
  return s.status === "reconnecting" ? fill(fr.ipCamera.state.reconnecting, { n: s.attempt }) : fr.ipCamera.state[s.status];
};

/** Settings of the "IP camera + local microphone" source: address, sound card, audio delay, calibration, capture state. */
export function IpCameraSettings({ view, devices, locked, onSettings, onRefreshDevices, onDelay, onCalibrate }: Props) {
  const [url, setUrl] = useState(view.settings.rtspUrl);
  const [seenUrl, setSeenUrl] = useState(view.settings.rtspUrl);
  // The saved address changed elsewhere: show it (state adjustment during render, no effect).
  if (seenUrl !== view.settings.rtspUrl) {
    setSeenUrl(view.settings.rtspUrl);
    setUrl(view.settings.rtspUrl);
  }
  const urlInvalid = url.trim() !== "" && !isRtspUrl(url);
  const commitUrl = () => {
    if (!urlInvalid && url.trim() !== view.settings.rtspUrl) onSettings({ rtspUrl: url.trim() });
  };
  const calibrating = view.calibration.status === "running";
  const result = describeCalibration(view.calibration);
  const choices = view.settings.audioDevice && !devices.includes(view.settings.audioDevice) ? [view.settings.audioDevice, ...devices] : devices;

  return (
    <>
      <Card>
        <Kicker>{fr.ipCamera.kindIp}</Kicker>
        <div className="grid gap-3.5">
          <Field label={fr.ipCamera.rtsp} help={urlInvalid ? undefined : fr.ipCamera.rtspHelp}>
            <input
              value={url}
              disabled={locked}
              placeholder="rtsp://…"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setUrl(e.target.value)}
              onBlur={commitUrl}
              onKeyDown={(e) => e.key === "Enter" && commitUrl()}
              aria-invalid={urlInvalid}
              className={inputClass}
            />
            {urlInvalid && <span className="mt-1 block text-[0.82rem] text-live">{fr.ipCamera.rtspInvalid}</span>}
          </Field>
          <Field label={fr.ipCamera.audio} help={fr.ipCamera.audioHelp}>
            <div className="flex gap-2">
              <select
                value={view.settings.audioDevice}
                disabled={locked}
                onChange={(e) => onSettings({ audioDevice: e.target.value })}
                className={selectClass}
              >
                <option value="">{choices.length ? fr.ipCamera.audioChoose : fr.ipCamera.audioNone}</option>
                {choices.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
              <Btn variante="ghost" disabled={locked} onClick={onRefreshDevices} aria-label={fr.ipCamera.audioRefresh} title={fr.ipCamera.audioRefresh}>
                ↻
              </Btn>
            </div>
          </Field>
          {view.ffmpeg === "missing" && <p className="m-0 text-[0.85rem] text-live">{fr.ipCamera.ffmpegMissing}</p>}
        </div>
      </Card>

      <Card>
        <Kicker>{fr.ipCamera.syncKicker}</Kicker>
        <p className="mb-3 mt-0 text-[0.85rem] text-muted">{fr.ipCamera.syncHint}</p>
        <div className="grid gap-3.5">
          <div>
            <p className="m-0 mb-1 text-[0.9rem] font-semibold">{fr.ipCamera.delay}</p>
            <div className="flex items-center gap-3">
              <Btn variante="ghost" disabled={locked || calibrating || view.delayMs <= 0} onClick={() => onDelay(view.delayMs - 50)}>
                {fr.ipCamera.delayLess}
              </Btn>
              <output aria-live="polite" className="min-w-24 text-center font-serif text-[1.4rem] leading-none text-deeper tabular-nums">
                {view.delayMs} ms
              </output>
              <Btn variante="ghost" disabled={locked || calibrating || view.delayMs >= 5000} onClick={() => onDelay(view.delayMs + 50)}>
                {fr.ipCamera.delayMore}
              </Btn>
              <span className="text-[0.82rem] text-muted">{fr.ipCamera.delayStep}</span>
            </div>
          </div>
          <div>
            <Btn disabled={locked || calibrating || view.ffmpeg === "missing" || !view.settings.rtspUrl || !view.settings.audioDevice} onClick={onCalibrate}>
              {calibrating ? fr.ipCamera.calibrating : fr.ipCamera.calibrate}
            </Btn>
            <p className="mb-0 mt-2 text-[0.85rem] text-muted" aria-live="polite">
              {calibrating ? <strong className="text-deeper">{fr.ipCamera.calibrateClap}</strong> : fr.ipCamera.calibrateHelp}
            </p>
            {result && !calibrating && (
              <p role="status" className={`mb-0 mt-2 rounded-lg px-3 py-2 text-[0.9rem] ${result.ok ? "bg-paper-2 text-deeper" : "bg-warn-bg text-warn"}`}>
                {result.text}
              </p>
            )}
          </div>
        </div>
      </Card>

      <Card>
        <Kicker>{fr.ipCamera.stateKicker}</Kicker>
        <p className="m-0 text-[0.95rem]">
          <span className="font-semibold text-deeper">{stateLabel(view)}</span>
          {view.state.lastError && view.state.status !== "running" && <span className="text-muted"> — {view.state.lastError}</span>}
        </p>
        {view.alert && <p className="mb-0 mt-2 rounded-lg bg-err-bg px-3 py-2 text-[0.9rem] text-[#7a1f20]">{fr.ipCamera.alert}</p>}
      </Card>
    </>
  );
}
