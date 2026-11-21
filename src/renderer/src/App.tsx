import { useKiosk } from "./hooks";
import { PairScreen } from "./screens/PairScreen";
import { StudioScreen } from "./screens/StudioScreen";

/** No login or password: either the device is paired and working, or it asks to be paired. */
export function App() {
  const kiosk = useKiosk();
  if (!kiosk) return <div className="min-h-screen" aria-busy="true" />;
  if (kiosk.phase === "unpaired" || kiosk.phase === "pairing" || kiosk.phase === "revoked") return <PairScreen kiosk={kiosk} />;
  return <StudioScreen kiosk={kiosk} />;
}
