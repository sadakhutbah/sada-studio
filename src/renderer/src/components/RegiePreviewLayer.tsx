import { buildPreview, type RegieLiveView } from "../regie-preview";
import { fr as t } from "../strings";

const CORNER_CLS: Record<string, string> = {
  tl: "left-3 top-3",
  tr: "right-3 top-3",
  bl: "bottom-3 left-3",
  br: "bottom-3 right-3",
};

/** HTML layer drawn over the monitor's <video>: active scene, QR, banner and logo, as the Régie requested them. */
export function RegiePreviewLayer({ view }: { view: RegieLiveView | null }) {
  const m = buildPreview(view);
  if (!m) return null;
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" data-testid="regie-preview">
      {m.covered && (
        <div className="absolute inset-0 grid place-content-center bg-deeper/95 text-center">
          <p className="m-0 font-serif text-[2rem] text-night-ink">{m.sceneLabel}</p>
        </div>
      )}
      {m.sceneLabel && (
        <span className="absolute left-1/2 top-2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-0.5 text-[0.78rem] font-semibold text-night-ink">
          {t.regie.scenes} : {m.sceneLabel}
        </span>
      )}
      {m.logo && (
        <span className="absolute left-3 top-3 grid size-12 place-content-center rounded-full border border-leaf bg-black/50 text-[0.7rem] font-semibold text-leaf">
          {t.regie.logoShort}
        </span>
      )}
      {m.qr && (
        <div className={`absolute flex w-24 flex-col items-center gap-1 rounded-md bg-white p-1.5 text-center ${CORNER_CLS[m.qr.corner] ?? CORNER_CLS.tr} ${m.logo && m.qr.corner === "tl" ? "top-18" : ""}`}>
          <div className="grid aspect-square w-full place-content-center bg-ink text-[0.9rem] font-bold text-white">QR</div>
          {m.qr.label && <span className="text-[0.66rem] font-semibold leading-tight text-ink">{m.qr.label}</span>}
        </div>
      )}
      {m.banner && (
        <div className="absolute inset-x-0 bottom-0 bg-deeper/90 px-5 py-2 text-night-ink">
          {m.banner.title && <p className="m-0 font-serif text-[1.3rem] leading-tight">{m.banner.title}</p>}
          {m.banner.subtitle && <p className="m-0 text-[0.85rem] text-night-muted">{m.banner.subtitle}</p>}
        </div>
      )}
    </div>
  );
}
