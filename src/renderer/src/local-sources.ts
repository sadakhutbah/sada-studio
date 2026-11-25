import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@core/errors";
import { t } from "@core/messages";
import { DEFAULT_BROWSER_SOURCE } from "@core/sources/browser-source";
import type { StudioSceneCompositor } from "@core/sources/compositor";
import { findRemembered, rememberedFrom, type RememberedScreen } from "@core/sources/remembered";
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
  savedScreen: RememberedScreen | null = null,
  onPersistScreen: (s: RememberedScreen) => void = () => undefined,
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
  // Last shared screen: read once at launch, then kept up to date with the operator's choices.
  const remembered = useRef<RememberedScreen | null>(savedScreen);
  const [suggestPick, setSuggestPick] = useState(false);

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

  const remember = useCallback(
    (s: DesktopSourceInfo) => {
      remembered.current = rememberedFrom(s);
      onPersistScreen(remembered.current);
    },
    [onPersistScreen],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setScreenError(null);
    setDenied(false);
    try {
      const list = await bridge.sources.screen.list();
      setSources(list);
      // A window's id changes when it is reopened: follow the remembered one by its name when the chosen id vanished.
      setScreenId((current) => {
        if (!current || list.some((s) => s.id === current)) return current;
        return findRemembered(remembered.current, list)?.id ?? current;
      });
    } catch (e) {
      setScreenError(messageOf(e));
      setDenied(e instanceof ApiError && e.code === "screen_denied");
    } finally {
      setLoading(false);
    }
  }, []);

  // At launch, offer the last shared screen again: chosen if it still exists (sharing itself stays off until the operator
  // switches it on: nothing goes on air by itself), otherwise the picker opens. The list is only read when the system
  // already allows it, so that no permission prompt appears at startup.
  useEffect(() => {
    const last = remembered.current;
    if (!last) return;
    let alive = true;
    void (async () => {
      try {
        if ((await window.studio.sources.screen.access()) !== "granted") return;
        const list = await bridge.sources.screen.list();
        if (!alive) return;
        setSources(list);
        const found = findRemembered(last, list);
        if (found) {
          setScreenId(found.id);
          if (found.id !== last.id) remember(found);
        } else {
          setScreenError(t("screen.gone"));
          setSuggestPick(true);
        }
      } catch {
        /* no list at launch (no permission, no screen): the operator picks later */
      }
    })();
    return () => {
      alive = false;
    };
  }, [remember]);

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
        suggestPick,
        onSelect: (id) => {
          setScreenId(id);
          setScreenError(null);
          setSuggestPick(false);
          const picked = sources.find((s) => s.id === id);
          if (picked) remember(picked);
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
    [config, status, browserError, start, screenOn, screenId, sources, loading, screenError, denied, suggestPick, refresh, remember],
  );

  return { props, browserVisible, screenActive: screenOn && screenId !== "", screenSourceId: screenId, failScreen };
}
