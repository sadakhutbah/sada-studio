import type { CalibrationView } from "@core/capture/settings";
import { AUDIO_DELAY_MAX_MS, AUDIO_DELAY_STEP_MS } from "@core/capture/types";
import { describeCalibration } from "../calibration-text";
import { fr } from "../strings";
import { Btn } from "../ui";

/** Calibration assistant (all sources): instruction while it listens, then the new delay, or a failure with a retry button. */
export function CalibrationWizard({ calibration, onRetry, onClose }: { calibration: CalibrationView; onRetry: () => void; onClose: () => void }) {
  const running = calibration.status !== "done";
  const result = describeCalibration(calibration);
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

/** Audio delay in 50 ms steps (section "Advanced", all sources). */
export function DelayStepper({ delayMs, disabled, onDelay }: { delayMs: number; disabled: boolean; onDelay: (ms: number) => void }) {
  return (
    <div>
      <p className="m-0 mb-1 text-[0.9rem] font-semibold">{fr.ipCamera.delay}</p>
      <div className="flex items-center gap-3">
        <Btn variante="ghost" disabled={disabled || delayMs <= 0} onClick={() => onDelay(delayMs - AUDIO_DELAY_STEP_MS)}>
          {fr.ipCamera.delayLess}
        </Btn>
        <output aria-live="polite" className="min-w-24 text-center font-serif text-[1.4rem] leading-none text-deeper tabular-nums">
          {delayMs} ms
        </output>
        <Btn variante="ghost" disabled={disabled || delayMs >= AUDIO_DELAY_MAX_MS} onClick={() => onDelay(delayMs + AUDIO_DELAY_STEP_MS)}>
          {fr.ipCamera.delayMore}
        </Btn>
      </div>
    </div>
  );
}
