import type { CalibrationView } from "../../core/capture/settings";
import { t } from "../../core/messages";
import { fill, fr } from "./strings";

/** Message of a finished calibration run, in the UI language. */
export function describeCalibration(c: CalibrationView): { ok: boolean; text: string } | null {
  if (c.status !== "done") return null;
  const r = c.result;
  if (r.ok) {
    return r.audioBehind
      ? { ok: false, text: t("capture.calib.audioBehind") }
      : { ok: true, text: fill(fr.ipCamera.calibrated, { delay: r.delayMs }) };
  }
  if (r.reason === "no-audio") return { ok: false, text: t("capture.calib.noAudio") };
  if (r.reason === "no-video") return { ok: false, text: t("capture.calib.noVideo") };
  if (r.reason === "no-clap") return { ok: false, text: t("capture.calib.noClap") };
  return { ok: false, text: t("capture.calib.ffmpeg", { detail: "detail" in r ? r.detail : "" }) };
}
