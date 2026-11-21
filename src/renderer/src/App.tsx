import { useEffect, useState } from "react";
import type { SessionInfo } from "@core/api/types";
import { ApiError } from "@core/errors";
import type { RememberState } from "@shared/ipc";
import { loadPrefs, savePrefs } from "./prefs";
import { LoginScreen } from "./screens/LoginScreen";
import { MosquePicker } from "./screens/MosquePicker";
import { StudioScreen } from "./screens/StudioScreen";

type Phase = "boot" | "login" | "picker" | "studio";

/** Si le compte n'a qu'une mosquée, ou si la mosquée est déjà ouverte, on n'affiche pas le choix. */
function nextPhase(s: SessionInfo): Phase {
  return s.mosque ? "studio" : "picker";
}

export function App() {
  const [phase, setPhase] = useState<Phase>("boot");
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [remember, setRemember] = useState<RememberState>({ available: false, saved: null });
  const [notice, setNotice] = useState("");

  const accept = (s: SessionInfo) => {
    setSession(s);
    setPhase(nextPhase(s));
  };

  useEffect(() => {
    void (async () => {
      const state = await window.studio.rememberState();
      if (state.ok) setRemember(state.value);
      if (state.ok && state.value.saved) {
        const r = await window.studio.autoLogin();
        if (r.ok) return accept(r.value);
        setNotice(r.message);
      }
      setPhase("login");
    })();
  }, []);

  const pick = async (id: number) => {
    const r = await window.studio.selectMosque(id);
    if (!r.ok) throw new ApiError(r.status, r.message);
    savePrefs({ ...loadPrefs(), mosqueId: id });
    accept(r.value);
  };

  const logout = async (forget: boolean) => {
    await window.studio.logout(forget);
    setSession(null);
    setPhase("login");
  };

  if (phase === "boot") return <div className="min-h-screen" aria-busy="true" />;
  if (phase === "login" || !session) {
    return <LoginScreen remember={remember} notice={notice} onSession={accept} />;
  }
  if (phase === "picker") return <MosquePicker session={session} onPick={pick} onLogout={() => logout(false)} />;
  return (
    <StudioScreen
      session={session}
      onSwitchMosque={() => setPhase("picker")}
      onLogout={() => logout(false)}
    />
  );
}
