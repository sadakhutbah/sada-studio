import { useState, type FormEvent } from "react";
import type { SessionInfo } from "@core/api/types";
import type { RememberState } from "@shared/ipc";
import { fr } from "../strings";
import { Brand, Btn, ErrorBox, Field, inputClass } from "../ui";

export function LoginScreen({
  remember,
  notice,
  onSession,
}: {
  remember: RememberState;
  notice: string;
  onSession: (s: SessionInfo) => void;
}) {
  const t = fr.login;
  const [error, setError] = useState(notice);
  const [busy, setBusy] = useState(false);
  const [keep, setKeep] = useState(remember.available);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    const f = new FormData(e.currentTarget);
    const r = await window.studio.login(
      { baseUrl: String(f.get("baseUrl")), username: String(f.get("username")), password: String(f.get("password")) },
      keep,
    );
    setBusy(false);
    if (r.ok) onSession(r.value);
    else setError(r.message);
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-[420px]">
        <div className="mb-5 text-center">
          <Brand />
          <p className="m-0 font-serif text-[2rem] leading-none text-deeper">
            {fr.app.name} <span className="text-green">{fr.app.studio}</span>
          </p>
        </div>
        <form onSubmit={submit} className="rounded-[10px] border border-line bg-white p-6.5">
          <h1 className="mb-4 font-serif text-[1.55rem] font-normal text-deeper">{t.title}</h1>
          <div className="grid gap-3.5">
            <Field label={t.instance} help={t.instanceHelp}>
              <input
                name="baseUrl"
                defaultValue={remember.saved?.baseUrl ?? ""}
                placeholder="console.sadakhutbah.org"
                autoComplete="url"
                spellCheck={false}
                required
                className={inputClass}
              />
            </Field>
            <Field label={t.user}>
              <input name="username" defaultValue={remember.saved?.username ?? ""} autoComplete="username" required className={inputClass} />
            </Field>
            <Field label={t.password}>
              <input name="password" type="password" autoComplete="current-password" required className={inputClass} />
            </Field>
            {remember.available ? (
              <label className="flex items-start gap-2.5 text-[0.9rem]">
                <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} className="mt-1" />
                <span>
                  {t.remember}
                  <span className="block text-[0.82rem] text-muted">{t.rememberHelp}</span>
                </span>
              </label>
            ) : (
              <p className="text-[0.82rem] text-muted">{t.noVault}</p>
            )}
            {error && <ErrorBox>{error}</ErrorBox>}
            <Btn type="submit" disabled={busy}>
              {busy ? t.sending : t.submit}
            </Btn>
          </div>
        </form>
      </div>
    </div>
  );
}
