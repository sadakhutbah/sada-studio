import { useState, type FormEvent } from "react";
import { formatCountdown } from "@core/kiosk/format";
import type { KioskSnapshot } from "@shared/ipc";
import { useNow } from "../hooks";
import { loadPrefs, savePrefs } from "../prefs";
import { fill, fr } from "../strings";
import { Brand, Btn, ErrorBox, Field, inputClass } from "../ui";

/** Premier lancement (ou appareil retiré) : l'adresse de l'instance, puis un grand code à saisir dans la console. */
export function PairScreen({ kiosk }: { kiosk: KioskSnapshot }) {
  const t = fr.pair;
  const pairing = kiosk.phase === "pairing" ? kiosk.pairing : null;
  const now = useNow(pairing !== null);
  const [instance, setInstance] = useState(() => kiosk.baseUrl || loadPrefs().instance);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    const r = await window.studio.kiosk.startPairing(instance);
    setBusy(false);
    if (r.ok) savePrefs({ ...loadPrefs(), instance });
    else setError(r.message);
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-[520px]">
        <div className="mb-5 text-center">
          <Brand />
          <p className="m-0 font-serif text-[2rem] leading-none text-deeper">
            {fr.app.name} <span className="text-green">{fr.app.studio}</span>
          </p>
        </div>
        <section className="rounded-[10px] border border-line bg-white p-6.5">
          {kiosk.notice && (
            <div className="mb-4">
              <ErrorBox>
                {kiosk.phase === "revoked" && <strong className="block">{t.revokedTitle}</strong>}
                {kiosk.notice.message}
              </ErrorBox>
            </div>
          )}
          {pairing ? (
            <div className="text-center">
              <h1 className="mb-1 font-serif text-[1.55rem] font-normal text-deeper">{t.codeTitle}</h1>
              <p
                aria-label={pairing.userCode}
                className="my-4 select-all rounded-[10px] bg-paper-2 py-5 font-serif text-[3.6rem] leading-none tracking-[0.18em] text-deeper tabular-nums"
              >
                {pairing.userCode}
              </p>
              <p className="mb-2 text-[1.05rem] text-ink">{t.steps}</p>
              <p className="m-0 text-[0.9rem] text-muted" role="status">
                {t.waiting} {fill(t.expires, { t: formatCountdown(pairing.expiresAt - now) })}
              </p>
              <div className="mt-5">
                <Btn variante="ghost" onClick={() => void window.studio.kiosk.cancelPairing()}>
                  {t.change}
                </Btn>
              </div>
            </div>
          ) : (
            <form onSubmit={submit}>
              <h1 className="mb-1 font-serif text-[1.55rem] font-normal text-deeper">{t.title}</h1>
              <p className="mb-4 text-[0.9rem] text-muted">{t.intro}</p>
              <div className="grid gap-3.5">
                <Field label={t.instance} help={t.instanceHelp}>
                  <input
                    value={instance}
                    onChange={(e) => setInstance(e.target.value)}
                    placeholder="console.sadakhutbah.org"
                    autoComplete="url"
                    spellCheck={false}
                    required
                    className={inputClass}
                  />
                </Field>
                {!kiosk.persistent && <p className="m-0 text-[0.82rem] text-muted">{t.noVault}</p>}
                {error && <ErrorBox>{error}</ErrorBox>}
                <Btn type="submit" disabled={busy}>
                  {busy ? t.sending : t.submit}
                </Btn>
              </div>
            </form>
          )}
        </section>
      </div>
    </div>
  );
}
