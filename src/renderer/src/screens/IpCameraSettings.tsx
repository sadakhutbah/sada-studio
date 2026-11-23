import { useState } from "react";
import { isRtspUrl, type CaptureSettings, type CaptureView } from "@core/capture/settings";
import { describeCalibration } from "../calibration-text";
import { fill, fr } from "../strings";
import { Btn, Card, Field, inputClass, selectClass } from "../ui";

type Props = {
  view: CaptureView;
  devices: string[];
  locked: boolean;
  onSettings: (patch: Partial<CaptureSettings>) => void;
  onRefreshDevices: () => void;
  onDelay: (ms: number) => void;
  onCalibrate: () => void;
};

const stateLabel = (v: CaptureView) => {
  const s = v.state;
  return s.status === "reconnecting" ? fill(fr.ipCamera.state.reconnecting, { n: s.attempt }) : fr.ipCamera.state[s.status];
};

/** Calibration assistant: instruction while it listens, then the new delay, or a failure with a retry button. */
function CalibrationWizard({ view, onRetry, onClose }: { view: CaptureView; onRetry: () => void; onClose: () => void }) {
  const running = view.calibration.status !== "done";
  const result = describeCalibration(view.calibration);
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/50 p-4">
      <div role="dialog" aria-modal="true" aria-label={fr.ipCamera.calibrate} className="w-full max-w-[420px] rounded-xl bg-paper p-5 text-center">
        <h3 className="m-0 mb-3 font-serif text-[1.4rem] text-deeper">{fr.ipCamera.calibrate}</h3>
        <div aria-live="polite">
          {running ? (
            <>
              <p className="m-0 text-[1.05rem] font-semibold text-deeper">{fr.ipCamera.calibrateClap}</p>
              <p className="mb-0 mt-2 text-[0.85rem] text-muted">{fr.ipCamera.calibrating}</p>
            </>
          ) : (
            result && (
              <p role="status" className={`m-0 rounded-lg px-3 py-2 text-[1rem] ${result.ok ? "bg-paper-2 font-semibold text-deeper" : "bg-warn-bg text-warn"}`}>
                {result.text}
              </p>
            )
          )}
        </div>
        {!running && (
          <div className="mt-4 flex justify-center gap-2">
            {result && !result.ok && <Btn onClick={onRetry}>{fr.ipCamera.retry}</Btn>}
            <Btn autoFocus variante="ghost" onClick={onClose}>
              {fr.settings.close}
            </Btn>
          </div>
        )}
      </div>
    </div>
  );
}

/** Settings of the "IP camera + local microphone" source: address, sound card, Calibrate; the rest is under "Advanced". */
export function IpCameraSettings({ view, devices, locked, onSettings, onRefreshDevices, onDelay, onCalibrate }: Props) {
  const [url, setUrl] = useState(view.settings.rtspUrl);
  const [seenUrl, setSeenUrl] = useState(view.settings.rtspUrl);
  const [wizard, setWizard] = useState(false);
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
  const choices = view.settings.audioDevice && !devices.includes(view.settings.audioDevice) ? [view.settings.audioDevice, ...devices] : devices;
  const start = () => {
    setWizard(true);
    onCalibrate();
  };

  return (
    <Card>
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
        <Field label={fr.ipCamera.audio}>
          <select value={view.settings.audioDevice} disabled={locked} onChange={(e) => onSettings({ audioDevice: e.target.value })} className={selectClass}>
            <option value="">{choices.length ? fr.ipCamera.audioChoose : fr.ipCamera.audioNone}</option>
            {choices.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </Field>
        {view.ffmpeg === "missing" && <p className="m-0 text-[0.85rem] text-live">{fr.ipCamera.ffmpegMissing}</p>}
        <div>
          <Btn disabled={locked || calibrating || view.ffmpeg === "missing" || !view.settings.rtspUrl || !view.settings.audioDevice} onClick={start}>
            {fr.ipCamera.calibrate}
          </Btn>
        </div>

        <details className="rounded-lg border border-line px-3 py-2">
          <summary className="cursor-pointer select-none font-semibold text-deep">{fr.ipCamera.advanced}</summary>
          <div className="mt-3 grid gap-3.5">
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
              </div>
            </div>
            <div>
              <Btn variante="ghost" disabled={locked} onClick={onRefreshDevices}>
                ↻ {fr.ipCamera.audioRefresh}
              </Btn>
            </div>
            <p className="m-0 text-[0.9rem]">
              <span className="font-semibold text-deeper">{fr.ipCamera.stateKicker} : </span>
              {stateLabel(view)}
              {view.state.lastError && view.state.status !== "running" && <span className="text-muted"> — {view.state.lastError}</span>}
            </p>
            {view.alert && <p className="m-0 rounded-lg bg-err-bg px-3 py-2 text-[0.9rem] text-[#7a1f20]">{fr.ipCamera.alert}</p>}
          </div>
        </details>
      </div>
      {wizard && <CalibrationWizard view={view} onRetry={onCalibrate} onClose={() => setWizard(false)} />}
    </Card>
  );
}
