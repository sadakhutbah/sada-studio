import { useEffect, useRef } from "react";
import type { AudioSettings } from "@core/sources/types";
import type { Prefs } from "../prefs";
import { fr } from "../strings";
import { Btn, Card, Field, Kicker, selectClass } from "../ui";

type Props = {
  prefs: Prefs;
  cameras: MediaDeviceInfo[];
  microphones: MediaDeviceInfo[];
  locked: boolean;
  onChange: (patch: Partial<Prefs>) => void;
  onClose: () => void;
};

/** Dedicated settings view (camera, microphone, audio processing), opened from the header gear button. */
export function SettingsPanel({ prefs, cameras, microphones, locked, onChange, onClose }: Props) {
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
        aria-label={fr.settings.title}
        className="max-h-full w-full max-w-[520px] overflow-y-auto rounded-xl bg-paper p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="m-0 font-serif text-[1.4rem] text-deeper">{fr.settings.title}</h2>
          <button
            ref={closeButton}
            type="button"
            aria-label={fr.settings.close}
            onClick={onClose}
            className="min-h-9 min-w-9 cursor-pointer rounded-lg px-2 text-[1.2rem] text-deep hover:bg-paper-2"
          >
            ×
          </button>
        </div>
        <div className="grid gap-4">
          <Card>
            <Kicker>{fr.sources.kicker}</Kicker>
            <div className="grid gap-3.5">
              <Field label={fr.sources.camera}>
                <select value={prefs.videoDeviceId} disabled={locked} onChange={(e) => onChange({ videoDeviceId: e.target.value })} className={selectClass}>
                  <option value="">{cameras.length ? fr.sources.default : fr.sources.none}</option>
                  {cameras.map((d, i) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `${fr.sources.camera} ${i + 1}`}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={fr.sources.microphone}>
                <select value={prefs.audioDeviceId} disabled={locked} onChange={(e) => onChange({ audioDeviceId: e.target.value })} className={selectClass}>
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
        </div>
        <div className="mt-4 flex justify-end">
          <Btn variante="ghost" onClick={onClose}>
            {fr.settings.close}
          </Btn>
        </div>
      </div>
    </div>
  );
}
