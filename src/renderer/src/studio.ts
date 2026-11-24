import { BroadcastSession } from "@core/session/broadcast-session";
import { CameraSource } from "@core/sources/camera";
import { CompositedSource, StudioSceneCompositor } from "@core/sources/compositor";
import { IpCameraSource } from "@core/sources/ip-camera";
import { SourceRegistry } from "@core/sources/registry";
import { RoutingSource } from "@core/sources/routing";
import { ScreenSource } from "@core/sources/screen";
import { WhipTransport } from "@core/transport/whip";
import { bridge } from "./bridge";

/**
 * Composition root of the renderer: connects the domain objects to the browser and the bridge.
 * No React here — tests and other UIs can construct the same objects directly.
 */
export const sources = new SourceRegistry();
sources.register(new CameraSource());
sources.register(new IpCameraSource(bridge.capture));
sources.register(new ScreenSource());

export const compositor = new StudioSceneCompositor();
export const source = new CompositedSource(new RoutingSource(sources), compositor);

export const session = new BroadcastSession({
  source,
  transportFactory: () =>
    new WhipTransport({
      signaling: bridge.whip,
      onLog: (event, data) => void bridge.app.log(event, data),
    }),
  liveApi: bridge.live,
  onLog: (event, data) => void bridge.app.log(event, data),
});
