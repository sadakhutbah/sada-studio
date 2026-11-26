import { useEffect, useRef, useState } from "react";
import type { CalibrationView, CaptureSettings, CaptureView } from "@core/capture/settings";
import type { AudioSettings } from "@core/sources/types";
import { ControlSettings } from "../components/ControlSettings";
import { LanguageSettings } from "../components/LanguageSettings";
import { IpCameraSettings } from "./IpCameraSettings";
import { CalibrationWizard, DelayStepper } from "./SyncControls";
import type { Prefs } from "../prefs";
import { str } from "../strings";
import { Btn, Card, Field, Kicker, selectClass } from "../ui";

type Props = {
  prefs: Prefs;
  cameras: MediaDeviceInfo[];
  microphones: MediaDeviceInfo[];
  locked: boolean;
  onChange: (patch: Partial<Prefs>) => void;
  onClose: () => void;
  /** "IP camera + local microphone" source (state held by the main process). */
  capture: CaptureView | null;
  audioInputs: string[];
  onCaptureSettings: (patch: Partial<CaptureSettings>) => void;
  onRefreshAudioInputs: () => void;
  onCaptureDelay: (ms: number) => void;
  onCalibrate: () => void;
  /** Webcam synchronization (state held by the renderer, same assistant and same "Advanced" section). */
  webcam: { delayMs: number; calibration: CalibrationView; canCalibrate: boolean; onDelay: (ms: number) => void; onCalibrate: () => void };
};

/** Dedicated settings view (camera, microphone, audio processing), opened from the header gear button. */
export function SettingsPanel({
  prefs,
  cameras,
  microphones,
  locked,
  onChange,
  onClose,
  capture,
  audioInputs,
  onCaptureSettings,
  onRefreshAudioInputs,
  onCaptureDelay,
  onCalibrate,
  webcam,
}: Props) {
  const [wizard, setWizard] = useState(false);
  const ipMode = capture?.settings.sourceKind === "ip-camera";
  const webcamBusy = webcam.calibration.status === "running";
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButton.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const setAudio = (k: keyof AudioSettings, v: boolean) => onChange({ audio: { ...prefs.audio, [k]: v } });

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={str.settings.title}
        className="max-h-full w-full max-w-[520px] overflow-y-auto rounded-xl bg-paper p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="m-0 font-serif text-[1.4rem] text-deeper">{str.settings.title}</h2>
          <button
            ref={closeButton}
            type="button"
            aria-label={str.settings.close}
            onClick={onClose}
            className="min-h-9 min-w-9 cursor-pointer rounded-lg px-2 text-[1.2rem] text-deep hover:bg-paper-2"
          >
            ×
          </button>
        </div>
        <div className="grid gap-4">
          {capture && (
            <Card>
              <Kicker>{str.ipCamera.kind}</Kicker>
              <div role="radiogroup" aria-label={str.ipCamera.kind} className="grid grid-cols-2 gap-1 rounded-[9px] bg-paper-2 p-1">
                {(["camera", "ip-camera"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={capture.settings.sourceKind === k}
                    disabled={locked}
                    onClick={() => onCaptureSettings({ sourceKind: k })}
                    className={`min-h-9 cursor-pointer rounded-[7px] px-3 font-semibold disabled:cursor-not-allowed ${
                      capture.settings.sourceKind === k ? "bg-deep text-white" : "text-deep hover:bg-white/60"
                    }`}
                  >
                    {k === "camera" ? str.ipCamera.kindCamera : str.ipCamera.kindIp}
                  </button>
                ))}
              </div>
              {locked && <p className="mb-0 mt-2 text-[0.82rem] text-muted">{str.ipCamera.liveLocked}</p>}
            </Card>
          )}

          {capture?.settings.sourceKind === "ip-camera" ? (
            <IpCameraSettings
              view={capture}
              devices={audioInputs}
              locked={locked}
              onSettings={onCaptureSettings}
              onRefreshDevices={onRefreshAudioInputs}
              onDelay={onCaptureDelay}
              onCalibrate={onCalibrate}
            />
          ) : (
          <Card>
            <Kicker>{str.sources.kicker}</Kicker>
            <div className="grid gap-3.5">
              <Field label={str.sources.camera}>
                <select value={prefs.videoDeviceId} disabled={locked} onChange={(e) => onChange({ videoDeviceId: e.target.value })} className={selectClass}>
                  <option value="">{cameras.length ? str.sources.default : str.sources.none}</option>
                  {cameras.map((d, i) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `${str.sources.camera} ${i + 1}`}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={str.sources.microphone}>
                <select value={prefs.audioDeviceId} disabled={locked} onChange={(e) => onChange({ audioDeviceId: e.target.value })} className={selectClass}>
                  <option value="">{microphones.length ? str.sources.default : str.sources.noMic}</option>
                  {microphones.map((d, i) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `${str.sources.microphone} ${i + 1}`}
                    </option>
                  ))}
                </select>
              </Field>
              {locked && <p className="m-0 text-[0.82rem] text-muted">{str.sources.lockedLive}</p>}
              <div>
                <Btn
                  disabled={locked || webcamBusy || !webcam.canCalibrate}
                  onClick={() => {
                    setWizard(true);
                    webcam.onCalibrate();
                  }}
                >
                  {str.ipCamera.calibrate}
                </Btn>
              </div>
              <details className="rounded-lg border border-line px-3 py-2">
                <summary className="cursor-pointer select-none font-semibold text-deep">{str.ipCamera.advanced}</summary>
                <div className="mt-3 grid gap-3.5">
                  <DelayStepper delayMs={webcam.delayMs} disabled={locked || webcamBusy} onDelay={webcam.onDelay} />
                  <div>
                    <p className="m-0 mb-1 text-[0.9rem] font-semibold">{str.audio.kicker}</p>
                    <p className="mb-2 mt-0 text-[0.82rem] text-muted">{str.audio.hint}</p>
                    <div className="grid gap-2">
                      {(["echoCancellation", "noiseSuppression", "autoGainControl"] as const).map((k) => (
                        <label key={k} className="flex items-center gap-2.5 text-[0.95rem]">
                          <input type="checkbox" checked={prefs.audio[k]} disabled={locked} onChange={(e) => setAudio(k, e.target.checked)} />
                          {str.audio[k]}
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              </details>
            </div>
          </Card>
          )}
          {wizard && !ipMode && <CalibrationWizard calibration={webcam.calibration} onRetry={webcam.onCalibrate} onClose={() => setWizard(false)} />}

          {ipMode && (
          <Card>
            <Kicker>{str.audio.kicker}</Kicker>
            <p className="mb-3 mt-0 text-[0.85rem] text-muted">{str.audio.hint}</p>
            <div className="grid gap-2">
              {(["echoCancellation", "noiseSuppression", "autoGainControl"] as const).map((k) => (
                <label key={k} className="flex items-center gap-2.5 text-[0.95rem]">
                  <input type="checkbox" checked={prefs.audio[k]} disabled={locked} onChange={(e) => setAudio(k, e.target.checked)} />
                  {str.audio[k]}
                </label>
              ))}
            </div>
          </Card>
          )}

          <LanguageSettings />
          <ControlSettings />
        </div>
        <div className="mt-4 flex justify-end">
          <Btn variante="ghost" onClick={onClose}>
            {str.settings.close}
          </Btn>
        </div>
      </div>
    </div>
  );
}
