import { createSelector, createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type {
  Compositing,
  LiveOverlays,
  LiveStatus,
  OverlayCorner,
  OverlayKind,
  RegieData,
  RegieScene,
  SceneKind,
  TransitionMode,
} from "../api/types";
import type { MuteSyncState } from "../audio/mute-sync";

/**
 * Régie state, held in Redux.
 *
 * - `server`: the last state the server confirmed. A state whose `rev` is older than the last one known is ignored;
 *   without a `rev` (old server) a poll answer is only applied when no command was issued while it was in flight
 *   (`fresh`, computed by a `WriteFence`).
 * - `optimistic`: one entry per control being changed (`PendingKey`). The view shows it over `server` from the click
 *   on; it stays after the answer until the server state agrees (or clearly moved on), so a fade that still reports
 *   the previous scene never makes the button jump back. A failure drops it (one change back to the server state).
 * - `drafts`: what the operator types for the QR code and the banner; only the first load fills them.
 */

export const DEFAULT_OVERLAYS: LiveOverlays = {
  qr: { visible: false, url: "", label: "", corner: "tr" },
  banner: { visible: false, title: "", subtitle: "" },
  logo: { visible: false },
};

/** Consecutive failed polls before the data shown is flagged as out of date. */
export const STALE_AFTER_FAILURES = 2;
/** Accepted server states that disagree with a settled command before its optimistic value is given up. */
export const SETTLE_MISSES = 2;

export interface ServerView {
  reachable: boolean;
  scene: string;
  /** Manual scene (true) or automatic schedule (false). */
  override: boolean;
  transition: TransitionMode;
  overlays: LiveOverlays;
  /** The server's copy of the mute (the local microphone is `mic.muted`). */
  micMuted: boolean;
  compositing: Compositing;
}

export interface OverlaysPatch {
  qr?: Partial<LiveOverlays["qr"]>;
  banner?: Partial<LiveOverlays["banner"]>;
  logo?: Partial<LiveOverlays["logo"]>;
}

export interface ViewPatch {
  scene?: string;
  override?: boolean;
  transition?: TransitionMode;
  overlays?: OverlaysPatch;
}

export type PendingKey = "scene" | "transition" | "overlay.qr" | "overlay.banner" | "overlay.logo";
export const overlayKey = (kind: OverlayKind): PendingKey => `overlay.${kind}` as PendingKey;

export interface OptimisticEntry {
  /** Order of the commands (later ones are drawn over earlier ones). */
  id: number;
  patch: ViewPatch;
  /** "inflight": the command is on its way; "settling": answered, waiting for the server state to agree. */
  phase: "inflight" | "settling";
  /** `rev` of the command's answer: a later server state is the truth, whatever it says. */
  afterRev: number | null;
  misses: number;
}

export interface Drafts {
  qr: { url: string; label: string; corner: OverlayCorner };
  banner: { title: string; subtitle: string };
}

export interface RegieState {
  /** Bumped by `reset` (panel remounted for another mode): answers from before are dropped. */
  epoch: number;
  loaded: boolean;
  rev: number | null;
  server: ServerView;
  scenes: RegieScene[];
  /** Shown when the server lists no scene. */
  fallbackScenes: RegieScene[];
  optimistic: Partial<Record<PendingKey, OptimisticEntry>>;
  seq: number;
  drafts: Drafts;
  error: string | null;
  pollFailures: number;
  mic: MuteSyncState;
}

export interface RegieRootState {
  regie: RegieState;
}

const INITIAL_SERVER: ServerView = {
  reachable: false,
  scene: "",
  override: false,
  transition: "fade",
  overlays: DEFAULT_OVERLAYS,
  micMuted: false,
  compositing: "server",
};
const INITIAL_MIC: MuteSyncState = { muted: false, pending: false, synced: true, warning: null };

const draftsOf = (ov: LiveOverlays): Drafts => ({
  qr: { url: ov.qr.url || "", label: ov.qr.label || "", corner: ov.qr.corner || "tr" },
  banner: { title: ov.banner.title || "", subtitle: ov.banner.subtitle || "" },
});

export function initialRegieState(fallbackScenes: RegieScene[] = [], mic: MuteSyncState = INITIAL_MIC): RegieState {
  return {
    epoch: 0,
    loaded: false,
    rev: null,
    server: INITIAL_SERVER,
    scenes: [],
    fallbackScenes,
    optimistic: {},
    seq: 0,
    drafts: draftsOf(DEFAULT_OVERLAYS),
    error: null,
    pollFailures: 0,
    mic,
  };
}

const isTransition = (v: unknown): v is TransitionMode => v === "fade" || v === "cut";

function mergeOverlays(base: LiveOverlays, patch: OverlaysPatch | undefined): LiveOverlays {
  if (!patch) return base;
  return {
    qr: patch.qr ? { ...base.qr, ...patch.qr } : base.qr,
    banner: patch.banner ? { ...base.banner, ...patch.banner } : base.banner,
    logo: patch.logo ? { ...base.logo, ...patch.logo } : base.logo,
  };
}

/** Does the server state already show everything the patch asked for? */
export function patchHolds(server: ServerView, patch: ViewPatch): boolean {
  if (patch.scene !== undefined && server.scene !== patch.scene) return false;
  if (patch.override !== undefined && server.override !== patch.override) return false;
  if (patch.transition !== undefined && server.transition !== patch.transition) return false;
  for (const kind of ["qr", "banner", "logo"] as const) {
    const p = patch.overlays?.[kind] as Record<string, unknown> | undefined;
    if (!p) continue;
    const s = server.overlays[kind] as Record<string, unknown>;
    for (const k of Object.keys(p)) if (s[k] !== p[k]) return false;
  }
  return true;
}

/** Server fields a command answer may carry, by the command that produced it. */
export type ServerField = keyof ServerView;

/**
 * Applies a server state. `fresh`: no command was issued since the request started (WriteFence), used only when the
 * state has no `rev`. `own`: without a `rev`, only these fields are trusted (the answer of a command speaks for what it
 * changed, not for the rest). Returns whether the state was accepted.
 */
function applyServer(state: RegieState, s: LiveStatus, fresh: boolean, own?: readonly ServerField[]): boolean {
  const hasRev = typeof s.rev === "number";
  if (hasRev) {
    if (state.rev !== null && (s.rev as number) < state.rev) return false;
    state.rev = s.rev as number;
  } else if (!fresh) {
    return false;
  }
  const may = (f: ServerField) => hasRev || !own || own.includes(f);
  const sv = state.server;
  if (typeof s.reachable === "boolean" && may("reachable")) sv.reachable = s.reachable;
  if (typeof s.scene === "string" && may("scene")) sv.scene = s.scene;
  if (typeof s.override === "boolean" && may("override")) sv.override = s.override;
  if (isTransition(s.transition) && may("transition")) sv.transition = s.transition;
  if (s.overlays && may("overlays")) sv.overlays = mergeOverlays(DEFAULT_OVERLAYS, s.overlays);
  if (typeof s.mic_muted === "boolean" && may("micMuted")) sv.micMuted = s.mic_muted;
  if ((s.compositing === "studio" || s.compositing === "server") && may("compositing")) sv.compositing = s.compositing;
  return true;
}

/** After an accepted server state: drops the settled entries the server now agrees with or moved past. */
function settle(state: RegieState, countMiss: boolean): void {
  for (const key of Object.keys(state.optimistic) as PendingKey[]) {
    const e = state.optimistic[key];
    if (!e || e.phase !== "settling") continue;
    if (patchHolds(state.server, e.patch)) delete state.optimistic[key];
    else if (e.afterRev !== null && state.rev !== null && state.rev > e.afterRev) delete state.optimistic[key];
    else if (countMiss && ++e.misses >= SETTLE_MISSES) delete state.optimistic[key];
  }
}

export interface ServerPayload {
  epoch: number;
  status: LiveStatus;
  fresh: boolean;
}

const regieSlice = createSlice({
  name: "regie",
  initialState: initialRegieState,
  reducers: {
    /** A new Régie session (panel mounted again, live ↔ setup): everything but the microphone starts over. */
    reset(state) {
      return { ...initialRegieState(state.fallbackScenes, state.mic), epoch: state.epoch + 1 };
    },
    loaded(state, { payload }: PayloadAction<{ epoch: number; data: RegieData; fresh: boolean }>) {
      if (payload.epoch !== state.epoch) return;
      const d = payload.data;
      const status: LiveStatus = { ...d.status };
      if (isTransition(d.transition)) status.transition = d.transition;
      if (d.overlays) status.overlays = d.overlays;
      if (applyServer(state, status, payload.fresh)) settle(state, false);
      state.scenes = Array.isArray(d.scenes) ? d.scenes : [];
      // The only time the fields are filled from the server: afterwards they belong to the operator.
      if (!state.loaded) state.drafts = draftsOf(mergeOverlays(DEFAULT_OVERLAYS, status.overlays));
      state.loaded = true;
      state.error = null;
    },
    loadFailed(state, { payload }: PayloadAction<{ epoch: number; message: string }>) {
      if (payload.epoch === state.epoch) state.error = payload.message;
    },
    polled(state, { payload }: PayloadAction<ServerPayload>) {
      if (payload.epoch !== state.epoch) return;
      if (applyServer(state, payload.status, payload.fresh)) settle(state, true);
    },
    pollFailuresChanged(state, { payload }: PayloadAction<number>) {
      state.pollFailures = payload;
    },
    commandStarted(state, { payload }: PayloadAction<{ key: PendingKey; patch: ViewPatch }>) {
      state.seq += 1;
      state.optimistic[payload.key] = { id: state.seq, patch: payload.patch, phase: "inflight", afterRev: null, misses: 0 };
      state.error = null;
    },
    commandSucceeded(state, { payload }: PayloadAction<ServerPayload & { key: PendingKey; id: number; own: readonly ServerField[] }>) {
      if (payload.epoch !== state.epoch) return;
      // The command reached the server: the data shown is current again.
      state.pollFailures = 0;
      const accepted = applyServer(state, payload.status, payload.fresh, payload.own);
      const e = state.optimistic[payload.key];
      if (e && e.id === payload.id) {
        e.phase = "settling";
        e.afterRev = typeof payload.status.rev === "number" ? payload.status.rev : null;
      }
      if (accepted) settle(state, false);
    },
    commandFailed(state, { payload }: PayloadAction<{ epoch: number; key: PendingKey; id: number; message: string }>) {
      if (payload.epoch !== state.epoch) return;
      const e = state.optimistic[payload.key];
      // Only the latest request of this control decides; the view goes back to the server state in one step.
      if (e && e.id === payload.id) delete state.optimistic[payload.key];
      state.error = payload.message;
    },
    draftChanged(state, { payload }: PayloadAction<{ qr?: Partial<Drafts["qr"]>; banner?: Partial<Drafts["banner"]> }>) {
      if (payload.qr) state.drafts.qr = { ...state.drafts.qr, ...payload.qr };
      if (payload.banner) state.drafts.banner = { ...state.drafts.banner, ...payload.banner };
    },
    micChanged(state, { payload }: PayloadAction<MuteSyncState>) {
      state.mic = payload;
    },
    errorCleared(state) {
      state.error = null;
    },
  },
});

export const regieReducer = regieSlice.reducer;
export const regieActions = regieSlice.actions;

// ---- Selectors -------------------------------------------------------------------------------------------------

const selectRegie = (s: RegieRootState) => s.regie;
const selectServer = (s: RegieRootState) => s.regie.server;
const selectOptimistic = (s: RegieRootState) => s.regie.optimistic;

/** The state shown: server state with the pending and settling commands drawn over it. */
export const selectView = createSelector([selectServer, selectOptimistic], (server, optimistic): ServerView => {
  const entries = Object.values(optimistic)
    .filter((e): e is OptimisticEntry => Boolean(e))
    .sort((a, b) => a.id - b.id);
  if (entries.length === 0) return server;
  let v = server;
  for (const { patch } of entries) {
    v = {
      ...v,
      ...(patch.scene !== undefined ? { scene: patch.scene } : {}),
      ...(patch.override !== undefined ? { override: patch.override } : {}),
      ...(patch.transition !== undefined ? { transition: patch.transition } : {}),
      overlays: mergeOverlays(v.overlays, patch.overlays),
    };
  }
  return v;
});

/** A scene's drawing kind; older servers do not say, the camera scene is then "camera" and the others full screen. */
export const sceneKindOf = (s: RegieScene): SceneKind => s.scene_kind ?? (s.kind === "camera" ? "camera" : "full");

/** The scenes listed by the server (or the fallback list), each with its `scene_kind`. */
export const selectScenes = createSelector(
  [(s: RegieRootState) => s.regie.scenes, (s: RegieRootState) => s.regie.fallbackScenes],
  (scenes, fallback): RegieScene[] => (scenes.length > 0 ? scenes : fallback).map((sc) => (sc.scene_kind ? sc : { ...sc, scene_kind: sceneKindOf(sc) })),
);

/** What the programme looks like right now, optimistic values included: what the local compositor draws. */
export interface ProgramView {
  scene: string;
  /** Kind of the current scene ("camera" while it is unknown: nothing covers the camera). */
  sceneKind: SceneKind;
  /** Every scene carries its `scene_kind`. */
  scenes: RegieScene[];
  overlays: LiveOverlays;
  /** The local microphone (the truth for what this computer sends). */
  micMuted: boolean;
  compositing: Compositing;
}

export const selectProgramView = createSelector(
  [selectView, selectScenes, (s: RegieRootState) => s.regie.mic.muted],
  (view, scenes, micMuted): ProgramView => {
    const current = scenes.find((sc) => sc.id === view.scene);
    return {
      scene: view.scene,
      sceneKind: current ? sceneKindOf(current) : "camera",
      scenes,
      overlays: view.overlays,
      micMuted,
      compositing: view.compositing,
    };
  },
);

/** A control whose command is on its way (its button shows `aria-busy`; the others stay usable). */
export const selectPending = (s: RegieRootState, key: PendingKey): boolean => s.regie.optimistic[key]?.phase === "inflight";
/** The scene (or "auto") a scene command in flight is taking. */
export const selectPendingScene = (s: RegieRootState): { scene?: string; auto: boolean } | null => {
  const e = s.regie.optimistic.scene;
  if (!e || e.phase !== "inflight") return null;
  return { scene: e.patch.scene, auto: e.patch.override === false };
};
export const selectStale = (s: RegieRootState): boolean => s.regie.pollFailures >= STALE_AFTER_FAILURES;
export const selectDrafts = (s: RegieRootState) => s.regie.drafts;
export const selectError = (s: RegieRootState) => s.regie.error;
export const selectMic = (s: RegieRootState) => s.regie.mic;
export { selectRegie };
