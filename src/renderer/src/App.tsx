import { useKiosk } from "./hooks";
import { PairScreen } from "./screens/PairScreen";
import { StudioScreen } from "./screens/StudioScreen";

/** Pas d'identifiant ni de mot de passe : soit l'appareil est appairé et il travaille, soit il demande à l'être. */
export function App() {
  const kiosk = useKiosk();
  if (!kiosk) return <div className="min-h-screen" aria-busy="true" />;
  if (kiosk.phase === "unpaired" || kiosk.phase === "pairing" || kiosk.phase === "revoked") return <PairScreen kiosk={kiosk} />;
  return <StudioScreen kiosk={kiosk} />;
}
