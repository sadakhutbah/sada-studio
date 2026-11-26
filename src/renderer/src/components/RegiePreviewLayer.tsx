import type { ProgramView } from "@core/program/types";
import { str as t } from "../strings";

/**
 * Badge over the monitor naming the current scene. The picture itself is the composed programme (what goes on air):
 * scenes and overlays are drawn by the compositor, not imitated here.
 */
export function RegiePreviewLayer({ view }: { view: ProgramView | null }) {
  const label = view ? (view.scenes.find((s) => s.id === view.scene)?.label ?? "") : "";
  if (!label) return null;
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" data-testid="regie-preview">
      <span className="absolute left-1/2 top-2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-0.5 text-[0.78rem] font-semibold text-night-ink">
        {t.regie.scenes} : {label}
      </span>
    </div>
  );
}
