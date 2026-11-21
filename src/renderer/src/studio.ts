import { CameraSource } from "@core/sources/camera";
import { SourceRegistry } from "@core/sources/registry";
import { BroadcastSession } from "@core/session/broadcast-session";
import { WhipTransport } from "@core/transport/whip";
import { whipSignaling } from "./bridge";

/** Available sources. Screen sharing will be added here (see core/extension-points.ts). */
export const sources = new SourceRegistry().register("camera", () => new CameraSource());

/** Assembly: "camera" source + WHIP transport signaled by the Sada API. */
export function createBroadcast(): { session: BroadcastSession; source: ReturnType<typeof sources.create> } {
  const source = sources.create("camera");
  const session = new BroadcastSession({
    source,
    transportFactory: () => new WhipTransport({ signaling: whipSignaling }),
    connect: { maxVideoKbps: 4500 },
  });
  return { session, source };
}
