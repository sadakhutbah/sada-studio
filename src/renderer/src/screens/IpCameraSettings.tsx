import { useState } from "react";
import { isRtspUrl, type CaptureSettings, type CaptureView } from "@core/capture/settings";
import { fill, fr } from "../strings";
import { Btn, Card, Field, inputClass, selectClass } from "../ui";
import { CalibrationWizard, DelayStepper } from "./SyncControls";

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
            <DelayStepper delayMs={view.delayMs} disabled={locked || calibrating} onDelay={onDelay} />
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
      {wizard && <CalibrationWizard calibration={view.calibration} onRetry={onCalibrate} onClose={() => setWizard(false)} />}
    </Card>
  );
}
