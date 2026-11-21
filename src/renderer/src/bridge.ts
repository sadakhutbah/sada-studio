import { ApiError } from "@core/errors";
import type { Credentials, SessionInfo, StreamMeta, StudioApi } from "@core/api/types";
import type { WhipSignaling } from "@core/transport/whip";
import type { IpcResult } from "@shared/ipc";

function unwrap<T>(r: IpcResult<T>): T {
  if (!r.ok) throw new ApiError(r.status, r.message);
  return r.value;
}

/** `StudioApi` côté interface : chaque appel passe par le processus principal, qui détient la session Sada. */
export const ipcApi: StudioApi = {
  login: async (c: Credentials) => unwrap(await window.studio.login(c, false)),
  selectMosque: async (id: number) => unwrap(await window.studio.selectMosque(id)),
  logout: async () => void unwrap(await window.studio.logout(false)),
  announce: async (_meta: StreamMeta) => undefined,
  whip: {
    offer: async (sdp) => unwrap(await window.studio.whipOffer(sdp)),
    patchIce: async (resource, fragment) => void unwrap(await window.studio.whipPatch(resource, fragment)),
    close: async (resource) => void unwrap(await window.studio.whipClose(resource)),
  } satisfies WhipSignaling,
};

export type { SessionInfo };
