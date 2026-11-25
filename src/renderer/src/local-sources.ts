import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError } from "@core/errors";
import { t } from "@core/messages";
import { DEFAULT_BROWSER_SOURCE } from "@core/sources/browser-source";
import type { StudioSceneCompositor } from "@core/sources/compositor";
import type { RoutingSource } from "@core/sources/routing";
import type { BrowserSourceConfig, BrowserSourceStatus, DesktopSourceInfo } from "@core/sources/types";
import { bridge } from "./bridge";
import type { LocalSourcesProps } from "./components/LocalSources";
import type { Prefs } from "./prefs";
import { fr } from "./strings";

const IDLE: BrowserSourceStatus = { active: false, loading: false, visible: false, url: "", error: null };
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface LocalSourcesState {
  /** Props of the Régie panel's "local sources" section. */
  props: LocalSourcesProps;
  /** A web source is added, loaded and shown in the programme. */
  browserVisible: boolean;
  /** The programme is the shared screen or window (chosen and switched on). */
  screenActive: boolean;
  screenSourceId: string;
  /** The shared screen could not be captured: it is switched off and the message shown. */
  failScreen: (message: string) => void;
}

/**
 * State of the local sources, held by the studio screen so that it survives the Régie panel being remounted:
 * the web source (hidden window in the main process, frames pushed into the compositor) and the screen / window share.
 */
export function useLocalSources(
  compositor: StudioSceneCompositor,
  source: RoutingSource,
  saved: Prefs["browserSource"],
  onPersist: (b: Prefs["browserSource"]) => void,
): LocalSourcesState {
  const [config, setConfig] = useState<BrowserSourceConfig>({ ...DEFAULT_BROWSER_SOURCE, ...saved, visible: false });
  const [status, setStatus] = useState<BrowserSourceStatus>(IDLE);
  const [browserError, setBrowserError] = useState<string | null>(null);

  const [screenId, setScreenId] = useState("");
  const [screenOn, setScreenOn] = useState(false);
  const [sources, setSources] = useState<DesktopSourceInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [screenError, setScreenError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);

  // The main process owns the hidden window: follow it, and adopt it when the UI was reloaded under it.
  useEffect(() => {
    let alive = true;
    const off = window.studio.sources.browser.onStatus((s) => alive && setStatus(s));
    void bridge.sources.browser.status().then((s) => {
      if (!alive || !s) return;
      setStatus(s);
      if (s.active) setConfig((c) => ({ ...c, url: s.url, visible: s.visible }));
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const browserVisible = config.visible && status.active;
  useEffect(() => {
    compositor.setBrowserConfig({ ...config, visible: browserVisible });
  }, [compositor, config, browserVisible]);

  // Frames: taken by the compositor, then acknowledged so the main process may send the next one (it sends one at a time).
  useEffect(() => {
    if (!status.active) return;
    return window.studio.sources.browser.onFrame((f) => {
      try {
        compositor.pushBrowserFrame(f);
      } catch {
        /* a malformed frame is dropped */
      }
      window.studio.sources.browser.ackFrame();
    });
  }, [compositor, status.active]);

  useEffect(() => {
    onPersist({ url: config.url, mode: config.mode, corner: config.corner, size: config.size });
  }, [onPersist, config.url, config.mode, config.corner, config.size]);

  const start = useCallback(async (url: string) => {
    setBrowserError(null);
    setConfig((c) => ({ ...c, url, visible: true }));
    try {
      const s = await bridge.sources.browser.start(url);
      setStatus(s);
      setConfig((c) => ({ ...c, url: s.url || url }));
    } catch (e) {
      setConfig((c) => ({ ...c, visible: false }));
      setBrowserError(messageOf(e));
    }
  }, []);

  const failScreen = useCallback((message: string) => {
    setScreenOn(false);
    setScreenError(message);
  }, []);

  useEffect(() => source.onRecoverableEnded(() => failScreen(fr.regie.screenEnded)), [source, failScreen]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setScreenError(null);
    setDenied(false);
    try {
      setSources(await bridge.sources.screen.list());
    } catch (e) {
      setScreenError(messageOf(e));
      setDenied(e instanceof ApiError && e.code === "screen_denied");
    } finally {
      setLoading(false);
    }
  }, []);

  const props = useMemo<LocalSourcesProps>(
    () => ({
      browser: {
        config,
        status,
        error: browserError,
        onAdd: (url) => void start(url),
        onApplyUrl: (url) => void start(url),
        onRemove: () => {
          setConfig((c) => ({ ...c, visible: false }));
          void bridge.sources.browser.stop().catch((e) => setBrowserError(messageOf(e)));
        },
        onReload: () => void bridge.sources.browser.reload().catch((e) => setBrowserError(messageOf(e))),
        onVisible: (visible) => {
          setConfig((c) => ({ ...c, visible }));
          void bridge.sources.browser.setVisible(visible).catch((e) => setBrowserError(messageOf(e)));
        },
        onLayout: (patch) => setConfig((c) => ({ ...c, ...patch })),
      },
      screen: {
        active: screenOn,
        sourceId: screenId,
        sources,
        loading,
        error: screenError,
        denied,
        onRefresh: () => void refresh(),
        onSelect: (id) => {
          setScreenId(id);
          setScreenError(null);
        },
        onToggle: () => {
          if (screenOn) return setScreenOn(false);
          if (!screenId) return;
          void window.studio.sources.screen.access().then((a) => {
            if (a === "denied" || a === "restricted") {
              setDenied(true);
              setScreenError(t("screen.denied"));
            } else {
              setDenied(false);
              setScreenError(null);
              setScreenOn(true);
            }
          });
        },
        onOpenSettings: () => void window.studio.sources.screen.openSettings(),
      },
    }),
    [config, status, browserError, start, screenOn, screenId, sources, loading, screenError, denied, refresh],
  );

  return { props, browserVisible, screenActive: screenOn && screenId !== "", screenSourceId: screenId, failScreen };
}
