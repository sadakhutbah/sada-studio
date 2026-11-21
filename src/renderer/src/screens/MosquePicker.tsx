import { useEffect, useRef, useState } from "react";
import type { MosqueChoice, SessionInfo } from "@core/api/types";
import { fill, fr } from "../strings";
import { Brand, Btn, ErrorBox } from "../ui";

/** Choix de la mosquée : s'ouvre seul quand le compte n'en a qu'une, comme dans la console. */
export function MosquePicker({
  session,
  onPick,
  onLogout,
}: {
  session: SessionInfo;
  onPick: (id: number) => Promise<void>;
  onLogout: () => void;
}) {
  const t = fr.picker;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const auto = useRef(false);

  const choose = async (m: MosqueChoice) => {
    setError("");
    setBusy(m.id);
    try {
      await onPick(m.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : fr.common.error);
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!auto.current && session.mosques.length === 1 && !session.user.operator) {
      auto.current = true;
      void choose(session.mosques[0]);
    }
  }, []); // eslint-disable-line

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-[520px]">
        <div className="mb-5 text-center">
          <Brand />
          <p className="m-0 font-serif text-[2rem] leading-none text-deeper">{fr.app.name}</p>
        </div>
        <section className="rounded-[10px] border border-line bg-white p-6.5">
          <h1 className="mb-1 font-serif text-[1.55rem] font-normal text-deeper">{t.title}</h1>
          <p className="mb-4 text-[0.9rem] text-muted">{fill(t.hint, { name: session.user.name })}</p>
          {session.mosques.length === 0 && <p className="text-muted">{t.none}</p>}
          <ul className="m-0 grid max-h-[320px] list-none gap-1.5 overflow-y-auto p-0">
            {session.mosques.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void choose(m)}
                  className="flex min-h-11 w-full cursor-pointer items-center justify-between rounded-lg border border-line bg-paper px-3.5 py-2.5 text-left hover:bg-paper-2 disabled:cursor-wait"
                >
                  <span className="font-semibold text-deeper">{m.name}</span>
                  {m.access === "support" && <span className="text-[0.8rem] text-muted">{t.support}</span>}
                </button>
              </li>
            ))}
          </ul>
          {error && <div className="mt-3"><ErrorBox>{error}</ErrorBox></div>}
          <div className="mt-4">
            <Btn variante="ghost" onClick={onLogout}>
              {fr.nav.logout}
            </Btn>
          </div>
        </section>
      </div>
    </div>
  );
}
