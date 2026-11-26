import { useCallback, useEffect, useState } from "react";
import { acceleratorFromKeyEvent } from "@core/control/accelerator";
import type { ShortcutAction } from "@core/control/actions";
import { MAX_API_PORT, MIN_API_PORT, type ControlView } from "@core/control/settings";
import { ApiError } from "@core/errors";
import { unwrap } from "../bridge";
import { fill, str as t } from "../strings";
import { Btn, Card, Kicker } from "../ui";
import { inputCls, smallBtn } from "./regie-controls";

const IS_MAC = typeof navigator !== "undefined" && /^Mac/i.test(navigator.platform);

const shown = (accelerator: string) => accelerator.replace("CommandOrControl", IS_MAC ? "Cmd" : "Ctrl");

/** Global shortcuts and local API (Stream Deck, Companion): what is bound, what the system accepted, and the API token. */
export function ControlSettings() {
  const [view, setView] = useState<ControlView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [capturing, setCapturing] = useState<ShortcutAction | null>(null);
  const [port, setPort] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmToken, setConfirmToken] = useState(false);

  const adopt = useCallback((v: ControlView) => {
    setView(v);
    setPort((p) => (p === "" ? String(v.api.port) : p));
    setError(null);
  }, []);
  const fail = (e: unknown) => setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
  const run = (fn: () => Promise<ControlView>) => void fn().then(adopt, fail);

  useEffect(() => {
    let alive = true;
    void window.studio.control.get().then((r) => alive && adopt(unwrap(r)), (e) => alive && fail(e));
    return () => {
      alive = false;
    };
  }, [adopt]);

  // Capturing a shortcut: the next combination pressed is the shortcut. Handled before the dialog's own Escape.
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") return setCapturing(null);
      const accelerator = e.key === "Backspace" ? "" : acceleratorFromKeyEvent(e, IS_MAC);
      if (accelerator === null) return; // a modifier alone, or a key we do not accept: keep waiting
      const action = capturing;
      setCapturing(null);
      run(async () => unwrap(await window.studio.control.setShortcut(action, accelerator)));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing]); // eslint-disable-line

  if (!view) return error ? <p role="alert" className="m-0 text-[0.82rem] text-live">{error}</p> : null;
  const portNumber = Number(port);
  const portValid = Number.isInteger(portNumber) && portNumber >= MIN_API_PORT && portNumber <= MAX_API_PORT;

  return (
    <Card>
      <Kicker>{t.control.kicker}</Kicker>
      <p className="mb-3 mt-0 text-[0.85rem] text-muted">{t.control.shortcutsHint}</p>
      <ul className="m-0 grid list-none gap-2 p-0" data-testid="control-shortcuts">
        {view.shortcuts.map((s) => (
          <li key={s.action} className="grid gap-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-[15rem] flex-1 text-[0.92rem]">{t.control.actions[s.action]}</span>
              <kbd className="rounded-[6px] border border-line bg-paper-2 px-2 py-0.5 text-[0.82rem]">
                {capturing === s.action ? t.control.capturing : shown(s.accelerator) || t.control.none}
              </kbd>
              <Btn variante="ghost" className={smallBtn} onClick={() => setCapturing(capturing === s.action ? null : s.action)}>
                {t.control.change}
              </Btn>
              {s.accelerator && (
                <Btn variante="ghost" className={smallBtn} onClick={() => run(async () => unwrap(await window.studio.control.setShortcut(s.action, "")))}>
                  {t.control.remove}
                </Btn>
              )}
            </div>
            {(s.status === "failed" || s.status === "duplicate") && <p role="alert" className="m-0 text-[0.8rem] text-live">{t.control.status[s.status]}</p>}
          </li>
        ))}
      </ul>
      {capturing && <p className="mb-0 mt-2 text-[0.8rem] text-muted">{t.control.captureHint}</p>}

      <div className="mt-4 grid gap-2 border-t border-line pt-3">
        <p className="m-0 text-[0.9rem] font-semibold text-deep">{t.control.apiTitle}</p>
        <p className="m-0 text-[0.82rem] text-muted">{t.control.apiHelp}</p>
        <label className="flex items-center gap-2.5 text-[0.95rem]">
          <input type="checkbox" checked={view.api.enabled} onChange={(e) => run(async () => unwrap(await window.studio.control.setApi(e.target.checked, portValid ? portNumber : view.api.port)))} />
          {t.control.apiEnable}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-[0.9rem]">
            {t.control.apiPort}
            <input type="text" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} className={`${inputCls} w-24`} aria-invalid={!portValid} />
          </label>
          <Btn variante="ghost" className={smallBtn} disabled={!portValid || portNumber === view.api.port} onClick={() => run(async () => unwrap(await window.studio.control.setApi(view.api.enabled, portNumber)))}>
            {t.control.apiApply}
          </Btn>
          <span className="text-[0.82rem] text-muted">{view.api.running ? fill(t.control.apiRunning, { url: view.api.baseUrl }) : t.control.apiStopped}</span>
        </div>
        {view.api.error && <p role="alert" className="m-0 text-[0.82rem] text-live">{view.api.error}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[0.9rem]">{t.control.token}</span>
          <input
            readOnly
            type={showToken ? "text" : "password"}
            value={view.api.token}
            aria-label={t.control.token}
            onFocus={(e) => e.currentTarget.select()}
            className={`${inputCls} min-w-[12rem] flex-1 font-mono text-[0.78rem]`}
          />
          <Btn variante="ghost" className={smallBtn} aria-pressed={showToken} onClick={() => setShowToken(!showToken)}>
            {showToken ? t.control.tokenHide : t.control.tokenShow}
          </Btn>
          <Btn
            variante="ghost"
            className={smallBtn}
            onClick={() => {
              setCopied(false);
              void window.studio.control.copyToken().then((r) => (unwrap(r), setCopied(true)), fail);
            }}
          >
            {copied ? t.control.tokenCopied : t.control.tokenCopy}
          </Btn>
          {!confirmToken && (
            <Btn variante="dangerGhost" className={smallBtn} onClick={() => setConfirmToken(true)}>
              {t.control.tokenRegenerate}
            </Btn>
          )}
        </div>
        {confirmToken && (
          <div role="alertdialog" aria-label={t.control.tokenRegenerate} className="rounded-lg bg-err-bg px-3 py-2.5">
            <p className="m-0 mb-2 text-[0.85rem] text-[#7a1f20]">{t.control.tokenRegenerateHelp}</p>
            <div className="flex gap-2">
              <Btn
                variante="danger"
                className={smallBtn}
                onClick={() => {
                  setConfirmToken(false);
                  setCopied(false);
                  run(async () => unwrap(await window.studio.control.regenerateToken()));
                }}
              >
                {t.control.tokenRegenerateConfirm}
              </Btn>
              <Btn variante="ghost" className={smallBtn} onClick={() => setConfirmToken(false)}>
                {t.control.tokenKeep}
              </Btn>
            </div>
          </div>
        )}
      </div>
      {error && <p role="alert" className="mb-0 mt-2 text-[0.82rem] text-live">{error}</p>}
    </Card>
  );
}
