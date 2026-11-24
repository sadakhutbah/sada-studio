import { CameraSource } from "@core/sources/camera";
import { CompositedSource, StudioSceneCompositor } from "@core/sources/compositor";
import { IpCameraSource } from "@core/sources/ip-camera";
import { SourceRegistry } from "@core/sources/registry";
import { RoutingSource } from "@core/sources/routing";
import { ScreenSource } from "@core/sources/screen";
import { BroadcastSession } from "@core/session/broadcast-session";
import { WhipTransport } from "@core/transport/whip";
import { whipSignaling } from "./bridge";
import { MsePlayer } from "./mse-player";

/** Available sources: PC camera, IP camera + local mic, and desktop screen share. */
export const sources = new SourceRegistry()
  .register("camera", () => new CameraSource())
  .register("ip-camera", () => new IpCameraSource(() => new MsePlayer()))
  .register("screen", () => new ScreenSource());

export const compositor = new StudioSceneCompositor();

/**
 * Assembly: the source chosen in the settings is the same for the preview, manual live and schedule.
 */
export function createBroadcast(): { session: BroadcastSession; source: RoutingSource; composited: CompositedSource } {
  const source = new RoutingSource(
    Object.fromEntries(sources.ids().map((id) => [id, sources.create(id)])),
    "camera",
  );
  const composited = new CompositedSource(source, compositor);
  const session = new BroadcastSession({
    source: composited,
    transportFactory: () => new WhipTransport({ signaling: whipSignaling }),
    connect: { maxVideoKbps: 4500 },
  });
  return { session, source, composited };
}
