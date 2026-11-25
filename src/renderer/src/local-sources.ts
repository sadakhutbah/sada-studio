import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AudioSourceMix, MixInputId, MixSettings } from "@core/audio/source-mix";
import { clampVolume } from "@core/audio/source-mix";
import { ApiError } from "@core/errors";
import { t } from "@core/messages";
import { DEFAULT_BROWSER_SOURCE } from "@core/sources/browser-source";
import type { StudioSceneCompositor } from "@core/sources/compositor";
import { findRemembered, rememberedFrom, type RememberedScreen } from "@core/sources/remembered";
import type { RoutingSource } from "@core/sources/routing";
import type { ScreenAudioSupport } from "@core/sources/screen-audio";
import type { BrowserSourceConfig, BrowserSourceStatus, DesktopSourceInfo } from "@core/sources/types";
import { bridge } from "./bridge";
import type { ControlContext } from "./control-actions";
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
  /** What shortcuts and the local API drive (state read when the action runs, not when the screen was drawn). */
  control: Pick<ControlContext, "browser" | "screen">;
  /** The system sound can be asked for with the share (Windows): put in the source options. */
  screenSystemAudio: boolean;
  /** The shared screen could not be captured: it is switched off and the message shown. */
  failScreen: (message: string) => void;
}

/**
 * State of the local sources, held by the studio screen so that it survives the Régie panel being remounted:
 * the web source (hidden window in the main process, frames pushed into the compositor) and the screen / window share.
 */
export interface LocalSourcesOptions {
  compositor: StudioSceneCompositor;
  source: RoutingSource;
  /** Mix of the microphone with the sound of the screen and of the page. */
  mix: AudioSourceMix;
  browser: { saved: Prefs["browserSource"]; onPersist: (b: Prefs["browserSource"]) => void };
  screen: { saved: RememberedScreen | null; onPersist: (s: RememberedScreen) => void };
  audio: { saved: MixSettings; onPersist: (m: MixSettings) => void };
}

export function useLocalSources({ compositor, source, mix, browser: browserPrefs, screen: screenPrefs, audio: audioPrefs }: LocalSourcesOptions): LocalSourcesState {
  const { saved, onPersist } = browserPrefs;
  const savedScreen = screenPrefs.saved;
  const onPersistScreen = screenPrefs.onPersist;
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

  // Sound of the shared screen and of the web page: on/off and volume of each, applied live to the mix.
  const [mixSettings, setMixSettings] = useState<MixSettings>(audioPrefs.saved);
  const [audioSupport, setAudioSupport] = useState<ScreenAudioSupport>({ supported: false, reason: null });
  const [pageAudio, setPageAudio] = useState<MediaStream | null>(null);
  const [pageAudioError, setPageAudioError] = useState<string | null>(null);
  const { onPersist: onPersistAudio } = audioPrefs;
  useEffect(() => {
    mix.configure(mixSettings);
    onPersistAudio(mixSettings);
  }, [mix, mixSettings, onPersistAudio]);
  useEffect(() => {
    let alive = true;
    void bridge.sources.screen.audioSupport().then((s) => alive && setAudioSupport(s), () => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const setMixInput = useCallback((id: MixInputId, patch: Partial<MixSettings[MixInputId]>) => {
    setMixSettings((m) => ({ ...m, [id]: { ...m[id], ...patch, ...(patch.volume !== undefined ? { volume: clampVolume(patch.volume) } : {}) } }));
  }, []);

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

  // The page's sound is captured as soon as the page exists (the page itself stays muted on this computer), and only
  // reaches the mix while it is shown: a hidden page is silent in the live too.
  useEffect(() => {
    if (!status.active) return;
    let alive = true;
    let captured: MediaStream | null = null;
    void (async () => {
      try {
        const id = await bridge.sources.browser.audioSourceId();
        if (!alive || !id) return;
        captured = await navigator.mediaDevices.getUserMedia({
          video: false,
          audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: id } } as unknown as MediaTrackConstraints,
        });
        if (!alive) return captured.getTracks().forEach((tr) => tr.stop());
        setPageAudioError(null);
        setPageAudio(captured);
      } catch {
        if (alive) setPageAudioError(t("browser.audioFailed"));
      }
    })();
    return () => {
      alive = false;
      captured?.getTracks().forEach((tr) => tr.stop());
      setPageAudio(null);
    };
  }, [status.active]);
  useEffect(() => {
    mix.setInput("browser", browserVisible ? pageAudio : null);
  }, [mix, pageAudio, browserVisible]);

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

  // Switching the share on checks the system permission first (macOS); `null` when it is on, the message otherwise.
  const startScreen = useCallback(async (): Promise<string | null> => {
    const a = await window.studio.sources.screen.access();
    if (a === "denied" || a === "restricted") {
      setDenied(true);
      setScreenError(t("screen.denied"));
      return t("screen.denied");
    }
    setDenied(false);
    setScreenError(null);
    setScreenOn(true);
    return null;
  }, []);

  // The values an action sees are the latest ones, not those of the render that created the callback.
  const latest = useRef({ config, status, screenOn, screenId });
  useEffect(() => {
    latest.current = { config, status, screenOn, screenId };
  });
  const control = useMemo<LocalSourcesState["control"]>(
    () => ({
      browser: {
        state: () => (!latest.current.status.active ? "none" : latest.current.config.visible ? "shown" : "hidden"),
        setVisible: (visible) => {
          setConfig((c) => ({ ...c, visible }));
          void bridge.sources.browser.setVisible(visible).catch((e) => setBrowserError(messageOf(e)));
        },
      },
      screen: {
        on: () => latest.current.screenOn,
        hasSource: () => latest.current.screenId !== "",
        set: async (on) => {
          if (!on) {
            setScreenOn(false);
            return null;
          }
          return startScreen();
        },
      },
    }),
    [startScreen],
  );

  const props = useMemo<LocalSourcesProps>(
    () => ({
      browser: {
        config,
        status,
        error: browserError ?? pageAudioError,
        audio: { enabled: mixSettings.browser.enabled, volume: Math.round(mixSettings.browser.volume * 100), onEnabled: (enabled) => setMixInput("browser", { enabled }), onVolume: (pc) => setMixInput("browser", { volume: pc / 100 }) },
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
        audio: {
          enabled: mixSettings.screen.enabled,
          volume: Math.round(mixSettings.screen.volume * 100),
          onEnabled: (enabled) => setMixInput("screen", { enabled }),
          onVolume: (pc) => setMixInput("screen", { volume: pc / 100 }),
          supported: audioSupport.supported,
          reason: audioSupport.reason,
        },
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
          void startScreen();
        },
        onOpenSettings: () => void window.studio.sources.screen.openSettings(),
      },
    }),
    [config, status, browserError, start, screenOn, screenId, sources, loading, screenError, denied, suggestPick, refresh, remember, mixSettings, setMixInput, audioSupport, pageAudioError, startScreen],
  );

  return { props, browserVisible, screenActive: screenOn && screenId !== "", screenSourceId: screenId, screenSystemAudio: audioSupport.supported, control, failScreen };
}
