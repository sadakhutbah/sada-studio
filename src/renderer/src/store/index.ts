import { useSyncExternalStore } from "react";
import { useDispatch, useSelector } from "react-redux";
import type { RegieScene } from "@core/api/types";
import type { MuteSync } from "@core/audio/mute-sync";
import type { RegieRootState } from "@core/regie/state";
import { createRegieStore, type RegieDispatch, type RegieStore } from "@core/regie/store";
import { bridge } from "../bridge";
import { str as t } from "../strings";

export { storeControl, muteWarningText } from "./control";
export { watchProgramView, type RegieStore } from "@core/regie/store";
export { selectProgramView, type ProgramView } from "@core/regie/state";

/** Scenes shown while the server lists none (same identifiers as `FALLBACK_SCENE_IDS`). */
export const FALLBACK_SCENES: RegieScene[] = [
  { id: "khutba", kind: "camera", label: t.regie.scene.live },
  { id: "avant", kind: "slate", label: t.regie.scene.before },
  { id: "priere", kind: "slate", label: t.regie.scene.prayer },
  { id: "entracte", kind: "slate", label: t.regie.scene.intermission },
  { id: "termine", kind: "slate", label: t.regie.scene.ended },
];

/** The studio store, talking to the server through the preload bridge. */
export function createStudioStore(mute: MuteSync | null): RegieStore {
  return createRegieStore({ api: bridge.regie, mute, fallbackScenes: FALLBACK_SCENES });
}

export const useRegieDispatch = useDispatch.withTypes<RegieDispatch>();
export const useRegieSelector = useSelector.withTypes<RegieRootState>();

/** Reads the store outside of its `<Provider>` (the screen that creates it). */
export function useStoreValue<T>(store: RegieStore, select: (s: RegieRootState) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.getState()));
}
