import type { MuteSyncState } from "@core/audio/mute-sync";
import { t } from "@core/messages";
import { selectScenes, selectView } from "@core/regie/state";
import type { RegieStore } from "@core/regie/store";
import { setMicMuted, takeScene } from "@core/regie/thunks";
import type { ControlContext } from "../control-actions";

/** The non-blocking "not synchronised" line of the microphone, null when the server holds our value. */
export const muteWarningText = (mic: Pick<MuteSyncState, "warning">): string | null =>
  mic.warning ? t("mute.unsynced", { detail: mic.warning }) : null;

/**
 * Microphone and scenes for the shortcuts and the local API, through the same store as the Régie panel: a scene taken
 * from a Stream Deck shows on the panel at once, exactly like a click.
 */
export function storeControl(store: RegieStore): Required<Pick<ControlContext, "mic" | "scene">> {
  return {
    mic: {
      muted: () => store.getState().regie.mic.muted,
      set: async (target) => {
        const { warning } = await store.dispatch(setMicMuted(target));
        return { error: null, warning: warning ? muteWarningText({ warning }) : null };
      },
    },
    scene: {
      ready: () => store.getState().regie.loaded,
      ids: () => selectScenes(store.getState()).map((s) => s.id),
      current: () => selectView(store.getState()).scene || undefined,
      take: async (sceneId) => (await store.dispatch(takeScene(sceneId))).error,
    },
  };
}
