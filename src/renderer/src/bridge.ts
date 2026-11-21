import { ApiError } from "@core/errors";
import type { WhipSignaling } from "@core/transport/whip";
import type { IpcResult } from "@shared/ipc";

export function unwrap<T>(r: IpcResult<T>): T {
  if (!r.ok) throw new ApiError(r.status, r.message);
  return r.value;
}

/** Signalisation WHIP côté interface : chaque appel passe par le processus principal, qui détient le secret de l'appareil. */
export const whipSignaling: WhipSignaling = {
  offer: async (sdp) => unwrap(await window.studio.whipOffer(sdp)),
  patchIce: async (resource, fragment) => void unwrap(await window.studio.whipPatch(resource, fragment)),
  close: async (resource) => void unwrap(await window.studio.whipClose(resource)),
};
