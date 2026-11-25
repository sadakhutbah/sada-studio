import type { OverlayKind, TransitionMode } from "@core/api/types";
import { ApiError } from "@core/errors";
import type { WhepSignaling } from "@core/transport/whep";
import type { WhipSignaling } from "@core/transport/whip";
import type { IpcResult } from "@shared/ipc";

export function unwrap<T>(r: IpcResult<T>): T {
  if (!r.ok) throw new ApiError(r.status, r.message, r.code);
  return r.value;
}

/** WHIP signaling on the UI side: every call goes through the main process, which holds the device secret. */
export const whipSignaling: WhipSignaling = {
  offer: async (sdp) => unwrap(await window.studio.whipOffer(sdp)),
  patchIce: async (resource, fragment) => void unwrap(await window.studio.whipPatch(resource, fragment)),
  close: async (resource) => void unwrap(await window.studio.whipClose(resource)),
};

/** WHEP signalling of the setup programme view, through the main process (it holds the device secret). */
export const whepSignaling: WhepSignaling = {
  offer: async (sdp) => unwrap(await window.studio.setup.whepOffer(sdp)),
  close: async (resource) => void unwrap(await window.studio.setup.whepClose(resource)),
};

export const bridge = {
  sources: {
    browser: {
      status: () => window.studio.sources.browser.status(),
      start: async (url: string) => unwrap(await window.studio.sources.browser.start(url)),
      reload: async () => unwrap(await window.studio.sources.browser.reload()),
      setVisible: async (visible: boolean) => unwrap(await window.studio.sources.browser.setVisible(visible)),
      stop: async () => unwrap(await window.studio.sources.browser.stop()),
      audioSourceId: async () => unwrap(await window.studio.sources.browser.audioSourceId()),
    },
    screen: {
      list: async () => unwrap(await window.studio.sources.screen.list()),
      select: async (sourceId: string | null) => void unwrap(await window.studio.sources.screen.select(sourceId)),
      audioSupport: async () => unwrap(await window.studio.sources.screen.audioSupport()),
    },
  },
  setup: {
    enter: async () => unwrap(await window.studio.setup.enter()),
    leave: async () => void unwrap(await window.studio.setup.leave()),
  },
  regie: {
    get: async () => unwrap(await window.studio.regie.get()),
    status: async () => unwrap(await window.studio.regie.status()),
    command: async (cmd: string, arg?: string, transition?: TransitionMode) =>
      unwrap(await window.studio.regie.command(cmd, arg, transition)),
    setTransition: async (mode: TransitionMode) => unwrap(await window.studio.regie.setTransition(mode)),
    setMute: async (muted: boolean) => unwrap(await window.studio.regie.setMute(muted)),
    setOverlay: async (kind: OverlayKind, payload: Record<string, unknown>) =>
      unwrap(await window.studio.regie.setOverlay(kind, payload)),
    overlayLayer: async (etag: string | null) => unwrap(await window.studio.regie.overlayLayer(etag)),
  },
};
