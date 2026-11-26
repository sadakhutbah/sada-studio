import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/source-sans-3";
import "@fontsource/eb-garamond/400.css";
// SemiBold: the titles of the overlay banner, as the engine draws them (EB Garamond SemiBold).
import "@fontsource/eb-garamond/600.css";
import "./styles.css";
import { App } from "./App";
import { setUiLocale } from "./strings";

// The language comes from the main process (saved choice, else the system's): known before the first render.
void window.studio.locale
  .get()
  .then((v) => setUiLocale(v.locale))
  .catch(() => undefined)
  .then(() => {
    // Changed from the settings (or from another window): every label follows, no restart.
    window.studio.locale.onChange((v) => setUiLocale(v.locale));
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });
