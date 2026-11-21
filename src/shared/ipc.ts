import type { StreamMeta } from "../core/api/types";
import type { WindowsFacts } from "../core/health/health";
import type { ClientReport, KioskView } from "../core/kiosk/supervisor";
import type { UpdateStatus } from "../core/kiosk/update-gate";

/** Serializable result of an IPC call: errors keep their HTTP code (0 = network). */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; status: number; message: string };

/** The device state as the UI sees it: never the device secret. */
export type KioskSnapshot = KioskView & { update: UpdateStatus | null };

/** What the main process exposes to the UI (`window.studio`). */
export interface StudioBridge {
  kiosk: {
    get(): Promise<KioskSnapshot>;
    onChange(cb: (s: KioskSnapshot) => void): () => void;
    startPairing(baseUrl: string): Promise<IpcResult<null>>;
    cancelPairing(): Promise<IpcResult<null>>;
    unpair(): Promise<IpcResult<null>>;
    startManual(meta: StreamMeta): Promise<IpcResult<null>>;
    stopLive(): Promise<IpcResult<null>>;
    dismissConflict(): Promise<void>;
    /** State of the broadcast session and of the hardware, included in each heartbeat. */
    report(r: ClientReport): void;
    windowsFacts(): Promise<WindowsFacts | null>;
  };
  whipOffer(sdp: string): Promise<IpcResult<{ answer: string; resource: string }>>;
  whipPatch(resource: string, fragment: string): Promise<IpcResult<null>>;
  whipClose(resource: string): Promise<IpcResult<null>>;
}

declare global {
  interface Window {
    studio: StudioBridge;
  }
}
