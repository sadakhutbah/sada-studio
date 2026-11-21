import type { StreamMeta } from "../core/api/types";
import type { WindowsFacts } from "../core/health/health";
import type { ClientReport, KioskView } from "../core/kiosk/supervisor";
import type { UpdateStatus } from "../core/kiosk/update-gate";

/** Résultat sérialisable d'un appel IPC : les erreurs gardent leur code HTTP (0 = réseau). */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; status: number; message: string };

/** L'état du boîtier tel que l'interface le voit : jamais le secret de l'appareil. */
export type KioskSnapshot = KioskView & { update: UpdateStatus | null };

/** Ce que le processus principal expose à l'interface (`window.studio`). */
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
    /** État de la session d'émission et du matériel, repris dans chaque battement. */
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
