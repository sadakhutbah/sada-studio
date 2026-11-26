import type { ThunkAction, UnknownAction } from "@reduxjs/toolkit";
import type {
  LiveStatus,
  OverlayKind,
  OverlayUpdateResponse,
  RegieData,
  TransitionMode,
  TransitionResponse,
} from "../api/types";
import type { MuteSync } from "../audio/mute-sync";
import { commandFor } from "../control/scenes";
import type { WriteFence } from "./poller";
import {
  overlayKey,
  regieActions as A,
  selectView,
  type OverlaysPatch,
  type PendingKey,
  type RegieRootState,
  type ServerField,
  type ViewPatch,
} from "./state";

/** The Régie calls of the server, as the renderer reaches them (bridge) or a test fakes them. */
export interface RegieApi {
  get(): Promise<RegieData>;
  status(): Promise<LiveStatus>;
  command(cmd: string, arg?: string, transition?: TransitionMode): Promise<LiveStatus>;
  setTransition(mode: TransitionMode): Promise<TransitionResponse>;
  setOverlay(kind: OverlayKind, payload: Record<string, unknown>): Promise<OverlayUpdateResponse>;
}

export interface RegieExtra {
  api: RegieApi;
  /** Fallback for servers without `rev`: a poll answer is dropped when a command was issued while it was in flight. */
  fence: WriteFence;
  /** The local microphone; null when the store runs without one (tests, setup). */
  mute: MuteSync | null;
}

export type RegieThunk<R> = ThunkAction<Promise<R>, RegieRootState, RegieExtra, UnknownAction>;

export interface CommandResult {
  ok: boolean;
  error: string | null;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** The answer carries the state (newer servers always; older ones at least the scene). */
const carriesState = (s: LiveStatus | null | undefined): s is LiveStatus =>
  Boolean(s) && (typeof s?.rev === "number" || typeof s?.scene === "string");

/** The server's mute value, told to the local microphone (applied only when newer than our own last write). */
const forwardMute = (extra: RegieExtra, s: LiveStatus) => extra.mute?.remote(s.mic_muted, s.rev);

/** First read of the Régie (scenes, state, overlays): fills the form fields once. */
export const loadRegie = (): RegieThunk<void> => async (dispatch, getState, extra) => {
  const epoch = getState().regie.epoch;
  const fresh = extra.fence.begin();
  try {
    const data = await extra.api.get();
    dispatch(A.loaded({ epoch, data, fresh: fresh() }));
    if (data.status) forwardMute(extra, data.status);
  } catch (e) {
    dispatch(A.loadFailed({ epoch, message: message(e) }));
  }
};

/** One poll of the live state. Rejects on failure (the Poller counts failures and backs off). */
export const pollStatus = (): RegieThunk<void> => async (dispatch, getState, extra) => {
  const epoch = getState().regie.epoch;
  const fresh = extra.fence.begin();
  const status = await extra.api.status();
  dispatch(A.polled({ epoch, status, fresh: fresh() }));
  if (getState().regie.epoch === epoch) forwardMute(extra, status);
};

/**
 * One command: shown at once (optimistic), then the answer is applied. Only `key` is pending meanwhile, the other
 * controls stay usable. When the answer carries no state, one status read follows (through the same rev/fence filter).
 */
function runCommand(key: PendingKey, patch: ViewPatch, own: readonly ServerField[], call: () => Promise<LiveStatus>): RegieThunk<CommandResult> {
  return async (dispatch, getState, extra) => {
    const epoch = getState().regie.epoch;
    extra.fence.bump();
    dispatch(A.commandStarted({ key, patch }));
    const id = getState().regie.seq;
    let answer: LiveStatus;
    try {
      answer = (await call()) ?? {};
    } catch (e) {
      extra.fence.bump();
      const error = message(e);
      dispatch(A.commandFailed({ epoch, key, id, message: error }));
      return { ok: false, error };
    }
    extra.fence.bump(); // polls started before this answer are older than it
    dispatch(A.commandSucceeded({ epoch, key, id, status: answer, fresh: true, own }));
    forwardMute(extra, answer);
    if (!carriesState(answer) && key === "scene") {
      const fresh = extra.fence.begin();
      try {
        const status = await extra.api.status();
        dispatch(A.polled({ epoch, status, fresh: fresh() }));
        forwardMute(extra, status);
      } catch {
        /* the next poll will tell */
      }
    }
    return { ok: true, error: null };
  };
}

/** Takes a scene on air (the funeral prayer has its own command), with the transition currently shown. */
export const takeScene = (sceneId: string): RegieThunk<CommandResult> => (dispatch, getState, extra) => {
  const transition = selectView(getState()).transition;
  const c = commandFor(sceneId);
  return runCommand("scene", { scene: sceneId, override: true }, ["scene", "override"], () => extra.api.command(c.command, c.arg, transition))(dispatch, getState, extra);
};

/** Back to the automatic schedule (the server picks the scene). */
export const setAuto = (): RegieThunk<CommandResult> => (dispatch, getState, extra) =>
  runCommand("scene", { override: false }, ["scene", "override"], () => extra.api.command("auto"))(dispatch, getState, extra);

export const changeTransition = (mode: TransitionMode): RegieThunk<CommandResult> => (dispatch, getState, extra) =>
  runCommand("transition", { transition: mode }, ["transition"], () => extra.api.setTransition(mode))(dispatch, getState, extra);

export const setOverlay = (kind: OverlayKind, payload: Record<string, unknown>): RegieThunk<CommandResult> => (dispatch, getState, extra) =>
  runCommand(overlayKey(kind), { overlays: { [kind]: payload } as OverlaysPatch }, ["overlays"], () => extra.api.setOverlay(kind, payload))(dispatch, getState, extra);

/** The payload that shows/hides (`toggle`) or re-sends (`apply`) an overlay with the texts typed by the operator. */
export function overlayPayload(state: RegieRootState, kind: OverlayKind, mode: "toggle" | "apply"): Record<string, unknown> {
  const current = selectView(state).overlays[kind].visible;
  const visible = mode === "toggle" ? !current : current;
  const d = state.regie.drafts;
  if (kind === "qr") return { visible, url: d.qr.url, label: d.qr.label, corner: d.qr.corner };
  if (kind === "banner") return { visible, title: d.banner.title, subtitle: d.banner.subtitle };
  return { visible };
}

export const toggleOverlay = (kind: OverlayKind): RegieThunk<CommandResult> => (dispatch, getState, extra) =>
  setOverlay(kind, overlayPayload(getState(), kind, "toggle"))(dispatch, getState, extra);
export const applyOverlay = (kind: OverlayKind): RegieThunk<CommandResult> => (dispatch, getState, extra) =>
  setOverlay(kind, overlayPayload(getState(), kind, "apply"))(dispatch, getState, extra);

/** Mutes or restores the local microphone at once; the server is told in the background. `warning`: not synchronised. */
export const setMicMuted = (muted: boolean): RegieThunk<{ warning: string | null }> => async (_dispatch, _getState, extra) => {
  if (!extra.mute) return { warning: null };
  const o = await extra.mute.set(muted);
  return { warning: o.warning ? o.warning.message : null };
};

export const toggleMic = (): RegieThunk<{ warning: string | null }> => (dispatch, getState, extra) =>
  setMicMuted(!getState().regie.mic.muted)(dispatch, getState, extra);
