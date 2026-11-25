import { useState } from "react";
import type {
  BrowserSourceConfig,
  BrowserSourceCorner,
  BrowserSourceLayout,
  BrowserSourceMode,
  BrowserSourceSize,
  BrowserSourceStatus,
  DesktopSourceInfo,
} from "@core/sources/types";
import { removalStep, type RemovalEvent, type RemovalPhase } from "@core/sources/removal";
import { Btn } from "../ui";
import { fr as t } from "../strings";
import { EyeBtn, inputCls, smallBtn } from "./regie-controls";

const CORNERS: BrowserSourceCorner[] = ["tl", "tr", "bl", "br"];
const BROWSER_MODES: BrowserSourceMode[] = ["overlay", "fullscreen"];
const BROWSER_SIZES: BrowserSourceSize[] = ["sm", "md", "lg"];

export interface BrowserSourceControls {
  config: BrowserSourceConfig;
  status: BrowserSourceStatus;
  error: string | null;
  /** Adds the source (opens the page) and shows it. */
  onAdd: (url: string) => void;
  onRemove: () => void;
  onReload: () => void;
  /** Loads another address into the added source. */
  onApplyUrl: (url: string) => void;
  onVisible: (visible: boolean) => void;
  onLayout: (patch: Partial<BrowserSourceLayout>) => void;
}

export interface ScreenShareControls {
  active: boolean;
  sourceId: string;
  sources: DesktopSourceInfo[];
  loading: boolean;
  error: string | null;
  /** macOS refused the screen recording: the message comes with a button to the system settings. */
  denied: boolean;
  /** The remembered source is gone: open the list to pick another one. */
  suggestPick?: boolean;
  onRefresh: () => void;
  onSelect: (sourceId: string) => void;
  onToggle: () => void;
  onOpenSettings: () => void;
}

export interface LocalSourcesProps {
  browser: BrowserSourceControls;
  screen: ScreenShareControls;
}

/** Web source and screen / window share: what is added to the broadcast from this computer. */
export function LocalSources({ browser, screen }: LocalSourcesProps) {
  return (
    <div className="flex flex-col gap-2.5 border-t border-line pt-3" data-testid="local-sources">
      <div className="text-[0.76rem] font-semibold uppercase tracking-[0.1em] text-green">{t.regie.localSources}</div>
      <BrowserSourceRow {...browser} />
      <ScreenShareRow {...screen} />
    </div>
  );
}

function BrowserSourceRow({ config, status, error, onAdd, onRemove, onReload, onApplyUrl, onVisible, onLayout }: BrowserSourceControls) {
  const [url, setUrl] = useState(config.url);
  const [seenUrl, setSeenUrl] = useState(config.url);
  // The address changed outside the field (restored, rewritten by the main process): state adjusted during render.
  if (seenUrl !== config.url) {
    setSeenUrl(config.url);
    setUrl(config.url);
  }
  const added = status.active;
  // Removal asks first; showing or hiding never does (instant and reversible).
  const [removal, setRemoval] = useState<RemovalPhase>("idle");
  if (!added && removal !== "idle") setRemoval("idle");
  const stepRemoval = (event: RemovalEvent) => {
    const step = removalStep(removal, event);
    setRemoval(step.phase);
    if (step.remove) onRemove();
  };
  return (
    <div className="flex flex-col gap-1.5" onKeyDown={(e) => e.key === "Escape" && removal === "confirming" && stepRemoval("cancel")}>
      <div className="flex flex-wrap items-center gap-1.5">
        {added && (
          <EyeBtn
            visible={config.visible}
            label={`${config.visible ? t.regie.hide : t.regie.show} — ${t.regie.browserSource}`}
            onClick={() => onVisible(!config.visible)}
          />
        )}
        <span className="min-w-[115px] text-[0.9rem] font-semibold text-ink">{t.regie.browserSource}</span>
        <input
          type="text"
          inputMode="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t.regie.browserUrl}
          aria-label={t.regie.browserUrl}
          maxLength={2048}
          className={`${inputCls} min-w-[190px] flex-1`}
        />
        {added ? (
          <>
            <Btn variante="ghost" className={smallBtn} disabled={!url.trim() || url.trim() === status.url} onClick={() => onApplyUrl(url)}>
              {t.regie.apply}
            </Btn>
            <Btn variante="ghost" className={smallBtn} onClick={onReload}>
              {t.regie.browserReload}
            </Btn>
            <Btn variante="dangerGhost" className={smallBtn} disabled={removal === "confirming"} onClick={() => stepRemoval("ask")}>
              {t.regie.removeSource}
            </Btn>
          </>
        ) : (
          <Btn className={smallBtn} disabled={!url.trim()} onClick={() => onAdd(url)}>
            {t.regie.addBrowser}
          </Btn>
        )}
      </div>
      {added && removal === "confirming" && (
        <div role="alertdialog" aria-label={t.regie.removeConfirmTitle} className="ml-9 rounded-lg bg-err-bg px-3 py-2.5">
          <p className="m-0 font-semibold text-[#7a1f20]">{t.regie.removeConfirmTitle}</p>
          <p className="m-0 mb-2 text-[0.85rem] text-[#7a1f20]">
            {t.regie.removeConfirmHelp}
            {config.visible ? ` ${t.regie.removeConfirmShown}` : ""}
          </p>
          <div className="flex gap-2">
            <Btn variante="danger" className={smallBtn} onClick={() => stepRemoval("confirm")}>
              {t.regie.removeConfirm}
            </Btn>
            <Btn variante="ghost" className={smallBtn} autoFocus onClick={() => stepRemoval("cancel")}>
              {t.regie.removeKeep}
            </Btn>
          </div>
        </div>
      )}
      {added && (
        <div className="flex flex-wrap items-center gap-1.5 pl-9">
          <select
            value={config.mode}
            onChange={(e) => onLayout({ mode: e.target.value as BrowserSourceMode })}
            aria-label={t.regie.browserMode}
            className={inputCls}
          >
            {BROWSER_MODES.map((m) => (
              <option key={m} value={m}>
                {t.regie.browserModes[m]}
              </option>
            ))}
          </select>
          {config.mode === "overlay" && (
            <>
              <select
                value={config.corner}
                onChange={(e) => onLayout({ corner: e.target.value as BrowserSourceCorner })}
                aria-label={t.regie.browserPosition}
                className={inputCls}
              >
                {CORNERS.map((c) => (
                  <option key={c} value={c}>
                    {t.regie.corners[c]}
                  </option>
                ))}
              </select>
              <select
                value={config.size}
                onChange={(e) => onLayout({ size: e.target.value as BrowserSourceSize })}
                aria-label={t.regie.browserSize}
                className={inputCls}
              >
                {BROWSER_SIZES.map((s) => (
                  <option key={s} value={s}>
                    {t.regie.browserSizes[s]}
                  </option>
                ))}
              </select>
            </>
          )}
          {status.loading && <span className="text-[0.82rem] text-muted">{t.regie.browserLoading}</span>}
        </div>
      )}
      {!added && <p className="m-0 text-[0.8rem] text-muted">{t.regie.browserHint}</p>}
      {(error || status.error) && (
        <p role="alert" className="m-0 text-[0.82rem] text-live">
          {error ?? status.error}
        </p>
      )}
    </div>
  );
}

function ScreenShareRow({ active, sourceId, sources, loading, error, denied, suggestPick, onRefresh, onSelect, onToggle, onOpenSettings }: ScreenShareControls) {
  const [open, setOpen] = useState(false);
  const [suggested, setSuggested] = useState(false);
  // The remembered source no longer exists: the picker opens by itself, once (its list is already loaded).
  if (suggestPick && !suggested) {
    setSuggested(true);
    setOpen(true);
  }
  const chosen = sources.find((s) => s.id === sourceId);
  const toggleList = () => {
    if (!open) onRefresh();
    setOpen(!open);
  };
  return (
    <div className="flex flex-col gap-1.5 border-t border-line pt-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <EyeBtn
          visible={active}
          label={`${active ? t.regie.hide : t.regie.show} — ${t.regie.screenShare}`}
          disabled={!sourceId && !active}
          onClick={onToggle}
        />
        <span className="min-w-[115px] text-[0.9rem] font-semibold text-ink">{t.regie.screenShare}</span>
        <span className="min-w-0 flex-1 truncate text-[0.88rem] text-muted">
          {chosen ? `${chosen.kind === "screen" ? t.regie.screenKindScreen : t.regie.screenKindWindow} — ${chosen.name}` : sourceId ? t.regie.screenChosen : t.regie.screenNone}
        </span>
        <Btn variante="ghost" className={smallBtn} aria-expanded={open} onClick={toggleList}>
          {open ? t.regie.screenPickClose : t.regie.screenPick}
        </Btn>
        {open && (
          <Btn variante="ghost" className={smallBtn} disabled={loading} onClick={onRefresh}>
            {t.regie.screenRefresh}
          </Btn>
        )}
      </div>
      {open && (
        <div className="pl-9">
          {loading && sources.length === 0 && <p className="m-0 text-[0.82rem] text-muted">{t.regie.screenLoading}</p>}
          {!loading && !denied && sources.length === 0 && <p className="m-0 text-[0.82rem] text-muted">{t.regie.screenEmpty}</p>}
          <div role="radiogroup" aria-label={t.regie.screenShare} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {sources.map((src) => (
              <button
                key={src.id}
                type="button"
                role="radio"
                aria-checked={src.id === sourceId}
                onClick={() => onSelect(src.id)}
                className={`flex cursor-pointer flex-col gap-1 rounded-[8px] border p-1.5 text-left ${
                  src.id === sourceId ? "border-deep bg-paper-2" : "border-line bg-white hover:bg-paper-2"
                }`}
              >
                {src.thumbnailDataUrl ? (
                  <img src={src.thumbnailDataUrl} alt="" className="aspect-video w-full rounded-[5px] bg-night object-contain" />
                ) : (
                  <div className="aspect-video w-full rounded-[5px] bg-night" />
                )}
                <span className="truncate text-[0.8rem] text-ink">
                  {src.kind === "screen" ? t.regie.screenKindScreen : t.regie.screenKindWindow} — {src.name}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="m-0 text-[0.82rem] text-live">
          {error}
        </p>
      )}
      {denied && (
        <button type="button" className="w-fit cursor-pointer text-[0.82rem] underline" onClick={onOpenSettings}>
          {t.regie.screenOpenSettings}
        </button>
      )}
    </div>
  );
}
