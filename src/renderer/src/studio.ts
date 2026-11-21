import { CameraSource } from "@core/sources/camera";
import { SourceRegistry } from "@core/sources/registry";
import { BroadcastSession } from "@core/session/broadcast-session";
import { WhipTransport } from "@core/transport/whip";
import { ipcApi } from "./bridge";

/** Les sources disponibles. Le partage d'écran s'y ajoutera ici (voir core/extension-points.ts). */
export const sources = new SourceRegistry().register("camera", () => new CameraSource());

/** Assemblage : source « caméra » + transport WHIP signalé par l'API Sada. */
export function createBroadcast(): { session: BroadcastSession; source: ReturnType<typeof sources.create> } {
  const source = sources.create("camera");
  const session = new BroadcastSession({
    source,
    transportFactory: () => new WhipTransport({ signaling: ipcApi.whip }),
    connect: { maxVideoKbps: 4500 },
  });
  return { session, source };
}
