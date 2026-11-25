import { CameraSource } from "@core/sources/camera";
import { IpCameraSource } from "@core/sources/ip-camera";
import { SourceRegistry } from "@core/sources/registry";
import { RoutingSource } from "@core/sources/routing";
import { BroadcastSession } from "@core/session/broadcast-session";
import { WhipTransport } from "@core/transport/whip";
import { whipSignaling } from "./bridge";
import { MsePlayer } from "./mse-player";

/** Available sources: PC camera and IP camera + local mic. */
export const sources = new SourceRegistry()
  .register("camera", () => new CameraSource())
  .register("ip-camera", () => new IpCameraSource(() => new MsePlayer()));

/**
 * Assembly: the source chosen in the settings is the same for the preview, manual live and schedule.
 */
export function createBroadcast(): { session: BroadcastSession; source: RoutingSource } {
  const source = new RoutingSource(
    Object.fromEntries(sources.ids().map((id) => [id, sources.create(id)])),
    "camera",
  );
  const session = new BroadcastSession({
    source,
    transportFactory: () => new WhipTransport({ signaling: whipSignaling }),
    connect: { maxVideoKbps: 4500 },
  });
  return { session, source };
}
