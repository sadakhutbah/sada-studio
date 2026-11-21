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
