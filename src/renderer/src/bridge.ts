import type { OverlayKind, TransitionMode } from "@core/api/types";
import { ApiError } from "@core/errors";
import type { WhipSignaling } from "@core/transport/whip";
import type { IpcResult } from "@shared/ipc";

export function unwrap<T>(r: IpcResult<T>): T {
  if (!r.ok) throw new ApiError(r.status, r.message);
  return r.value;
}

/** WHIP signaling on the UI side: every call goes through the main process, which holds the device secret. */
export const whipSignaling: WhipSignaling = {
  offer: async (sdp) => unwrap(await window.studio.whipOffer(sdp)),
  patchIce: async (resource, fragment) => void unwrap(await window.studio.whipPatch(resource, fragment)),
  close: async (resource) => void unwrap(await window.studio.whipClose(resource)),
};

export const bridge = {
  regie: {
    get: async () => unwrap(await window.studio.regie.get()),
    status: async () => unwrap(await window.studio.regie.status()),
    command: async (cmd: string, arg?: string, transition?: TransitionMode) =>
      unwrap(await window.studio.regie.command(cmd, arg, transition)),
    setTransition: async (mode: TransitionMode) => unwrap(await window.studio.regie.setTransition(mode)),
    setOverlay: async (kind: OverlayKind, payload: Record<string, unknown>) =>
      unwrap(await window.studio.regie.setOverlay(kind, payload)),
  },
};
