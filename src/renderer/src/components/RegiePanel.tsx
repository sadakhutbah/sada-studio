import { useEffect, useState } from "react";
import type { LiveOverlays, LiveStatus, OverlayCorner, OverlayKind, RegieData } from "../../../core/api/types";
import { Btn, Card } from "../ui";
import { t } from "../strings";

const DEFAULT_OVERLAYS: LiveOverlays = {
  qr: { visible: false, url: "", label: "", corner: "tr" },
  banner: { visible: false, title: "", subtitle: "" },
  logo: { visible: false },
};

const SCENES = [
  { cmd: "live", scene: "direct" },
  { cmd: "before", scene: "avant" },
  { cmd: "prayer", scene: "priere" },
  { cmd: "intermission", scene: "entracte" },
  { cmd: "ended", scene: "termine" },
];

const CORNERS: OverlayCorner[] = ["tl", "tr", "bl", "br"];
const inputCls =
  "rounded-[7px] border border-night-line bg-night-deep px-2.5 py-1.5 text-[0.85rem] text-night-ink placeholder:text-night-dim";
const smallBtn = "min-h-8 px-2.5 py-1 text-[0.84rem]";

function EyeBtn({
  visible,
  label,
  disabled,
  onClick,
}: {
  visible: boolean;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={visible}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[7px] border transition-colors ${
        visible
          ? "border-leaf bg-leaf/20 text-leaf"
          : "border-night-line bg-night-deep text-night-dim hover:text-night-ink"
      } disabled:opacity-50`}
    >
      {visible ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
          <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c6.5 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
          <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3.5 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
          <line x1="2" y1="2" x2="22" y2="22" />
        </svg>
      )}
    </button>
  );
}

export function RegiePanel() {
  const [data, setData] = useState<RegieData | null>(null);
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [overlays, setOverlays] = useState<LiveOverlays>(DEFAULT_OVERLAYS);
  const [qrUrl, setQrUrl] = useState("");
  const [qrLabel, setQrLabel] = useState("");
  const [qrCorner, setQrCorner] = useState<OverlayCorner>("tr");
  const [bannerTitle, setBannerTitle] = useState("");
  const [bannerSubtitle, setBannerSubtitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function hydrateOverlays(ov?: LiveOverlays, updateFields = false) {
    if (!ov) return;
    setOverlays(ov);
    if (updateFields) {
      setQrUrl(ov.qr.url || "");
      setQrLabel(ov.qr.label || "");
      setQrCorner(ov.qr.corner || "tr");
      setBannerTitle(ov.banner.title || "");
      setBannerSubtitle(ov.banner.subtitle || "");
    }
  }

  useEffect(() => {
    let active = true;
    window.sadaStudio
      .getRegie()
      .then((d) => {
        if (!active) return;
        setData(d);
        setStatus(d.status);
        hydrateOverlays(d.overlays ?? d.status?.overlays, true);
      })
      .catch((e) => {
        if (active) setErr(e instanceof Error ? e.message : String(e));
      });

    const id = window.setInterval(() => {
      window.sadaStudio
        .getLiveStatus()
        .then((s) => {
          if (!active) return;
          setStatus(s);
          if (s.overlays) setOverlays(s.overlays);
        })
        .catch(() => {
          /* silent poll */
        });
    }, 3000);

    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, []);

  async function sendCmd(cmd: string) {
    setBusy(true);
    setErr(null);
    try {
      await window.sadaStudio.sendLiveCommand(cmd);
      const s = await window.sadaStudio.getLiveStatus();
      setStatus(s);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function updateOverlay(kind: OverlayKind, payload: Record<string, unknown>) {
    setBusy(true);
    setErr(null);
    try {
      const r = await window.sadaStudio.setLiveOverlay(kind, payload);
      hydrateOverlays(r.overlays, true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const st = status || data?.status || {};
  const reachable = Boolean(st.reachable);
  const scene = st.scene || "";
  const isAuto = !st.override;

  return (
    <Card title={t.regie.title}>
      <div className="flex flex-col gap-3">
        {err && (
          <div className="rounded-[7px] border border-red-500/40 bg-red-500/10 px-2.5 py-1.5 text-[0.84rem] text-red-200">
            {err}
          </div>
        )}

        {/* Scènes */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-[0.74rem] font-semibold uppercase tracking-[0.1em] text-night-dim">
            <span>{t.regie.scenes}</span>
            {!reachable && <span className="font-normal normal-case tracking-normal">{t.regie.offline}</span>}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {SCENES.map((s) => (
              <Btn
                key={s.cmd}
                variant={scene === s.scene ? "primary" : "secondary"}
                className={smallBtn}
                disabled={busy || !reachable}
                onClick={() => sendCmd(s.cmd)}
              >
                {t.regie.scene[s.cmd]}
              </Btn>
            ))}
            <Btn
              variant={isAuto && reachable ? "primary" : "secondary"}
              className={smallBtn}
              disabled={busy || !reachable}
              onClick={() => sendCmd("auto")}
            >
              {t.regie.auto}
            </Btn>
          </div>
        </div>

        {/* Sources / Incrustations */}
        <div className="flex flex-col gap-2.5 border-t border-night-line pt-3">
          <div className="text-[0.74rem] font-semibold uppercase tracking-[0.1em] text-night-dim">
            {t.regie.overlays}
          </div>

          {/* QR code */}
          <div className="flex flex-wrap items-center gap-1.5">
            <EyeBtn
              visible={overlays.qr.visible}
              label={`${overlays.qr.visible ? t.regie.hide : t.regie.show} — ${t.regie.qr}`}
              disabled={busy}
              onClick={() =>
                updateOverlay("qr", {
                  visible: !overlays.qr.visible,
                  url: qrUrl,
                  label: qrLabel,
                  corner: qrCorner,
                })
              }
            />
            <span className="min-w-[115px] text-[0.85rem] font-medium text-night-ink">{t.regie.qr}</span>
            <input
              type="url"
              value={qrUrl}
              onChange={(e) => setQrUrl(e.target.value)}
              placeholder={t.regie.qrUrl}
              maxLength={512}
              className={`${inputCls} min-w-[170px] flex-1`}
            />
            <input
              type="text"
              value={qrLabel}
              onChange={(e) => setQrLabel(e.target.value)}
              placeholder={t.regie.qrLabel}
              maxLength={60}
              className={`${inputCls} min-w-[120px] flex-1`}
            />
            <select
              value={qrCorner}
              onChange={(e) => setQrCorner(e.target.value as OverlayCorner)}
              aria-label={t.regie.qr}
              className={inputCls}
            >
              {CORNERS.map((c) => (
                <option key={c} value={c}>
                  {t.regie.corners[c]}
                </option>
              ))}
            </select>
            <Btn
              variant="secondary"
              className={smallBtn}
              disabled={busy}
              onClick={() =>
                updateOverlay("qr", {
                  visible: overlays.qr.visible,
                  url: qrUrl,
                  label: qrLabel,
                  corner: qrCorner,
                })
              }
            >
              {t.regie.apply}
            </Btn>
          </div>

          {/* Bandeau / Annonce */}
          <div className="flex flex-wrap items-center gap-1.5 border-t border-night-line/60 pt-2.5">
            <EyeBtn
              visible={overlays.banner.visible}
              label={`${overlays.banner.visible ? t.regie.hide : t.regie.show} — ${t.regie.banner}`}
              disabled={busy}
              onClick={() =>
                updateOverlay("banner", {
                  visible: !overlays.banner.visible,
                  title: bannerTitle,
                  subtitle: bannerSubtitle,
                })
              }
            />
            <span className="min-w-[115px] text-[0.85rem] font-medium text-night-ink">{t.regie.banner}</span>
            <input
              type="text"
              value={bannerTitle}
              onChange={(e) => setBannerTitle(e.target.value)}
              placeholder={t.regie.bannerTitle}
              maxLength={120}
              className={`${inputCls} min-w-[170px] flex-1`}
            />
            <input
              type="text"
              value={bannerSubtitle}
              onChange={(e) => setBannerSubtitle(e.target.value)}
              placeholder={t.regie.bannerSubtitle}
              maxLength={160}
              className={`${inputCls} min-w-[140px] flex-1`}
            />
            <Btn
              variant="secondary"
              className={smallBtn}
              disabled={busy}
              onClick={() =>
                updateOverlay("banner", {
                  visible: overlays.banner.visible,
                  title: bannerTitle,
                  subtitle: bannerSubtitle,
                })
              }
            >
              {t.regie.apply}
            </Btn>
          </div>

          {/* Logo de la mosquée */}
          <div className="flex items-center gap-1.5 border-t border-night-line/60 pt-2.5">
            <EyeBtn
              visible={overlays.logo.visible}
              label={`${overlays.logo.visible ? t.regie.hide : t.regie.show} — ${t.regie.logo}`}
              disabled={busy}
              onClick={() => updateOverlay("logo", { visible: !overlays.logo.visible })}
            />
            <span className="text-[0.85rem] font-medium text-night-ink">{t.regie.logo}</span>
          </div>
        </div>
      </div>
    </Card>
  );
}
