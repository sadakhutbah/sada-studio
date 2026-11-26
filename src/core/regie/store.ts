import { configureStore } from "@reduxjs/toolkit";
import type { RegieScene } from "../api/types";
import type { MuteSync } from "../audio/mute-sync";
import { WriteFence } from "./poller";
import { initialRegieState, regieActions, regieReducer, selectProgramView, type ProgramView, type RegieRootState } from "./state";
import type { RegieApi, RegieExtra } from "./thunks";

export interface RegieStoreDeps {
  api: RegieApi;
  /** The local microphone: its state is mirrored in the store, and the server's value is forwarded to it. */
  mute?: MuteSync | null;
  /** Scenes shown while the server lists none. */
  fallbackScenes?: RegieScene[];
}

/** The studio's Redux store: Régie state, local microphone, shared by the panel, the shortcuts and the local API. */
export function createRegieStore(deps: RegieStoreDeps) {
  const extra: RegieExtra = { api: deps.api, fence: new WriteFence(), mute: deps.mute ?? null };
  const store = configureStore({
    reducer: { regie: regieReducer },
    preloadedState: { regie: initialRegieState(deps.fallbackScenes ?? [], deps.mute?.state()) } satisfies RegieRootState,
    middleware: (getDefault) => getDefault({ thunk: { extraArgument: extra } }),
  });
  deps.mute?.subscribe((s) => store.dispatch(regieActions.micChanged(s)));
  return store;
}

export type RegieStore = ReturnType<typeof createRegieStore>;
export type RegieDispatch = RegieStore["dispatch"];

/**
 * Calls `cb` with the programme view now and on every change of it (memoized: unrelated store changes do not call
 * it). For the local compositor: `watchProgramView(store, (v) => compositor.setProgram(v))`.
 */
export function watchProgramView(store: Pick<RegieStore, "getState" | "subscribe">, cb: (view: ProgramView) => void): () => void {
  let last = selectProgramView(store.getState());
  cb(last);
  return store.subscribe(() => {
    const next = selectProgramView(store.getState());
    if (next !== last) {
      last = next;
      cb(next);
    }
  });
}
