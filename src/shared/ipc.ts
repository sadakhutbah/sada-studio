import type { Credentials, SessionInfo } from "../core/api/types";

/** Résultat sérialisable d'un appel IPC : les erreurs gardent leur code HTTP (0 = réseau). */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; status: number; message: string };

export interface RememberState {
  /** Le coffre du système (Keychain, DPAPI, libsecret) est utilisable. */
  available: boolean;
  saved: { baseUrl: string; username: string } | null;
}

/** Ce que le processus principal expose à l'interface (`window.studio`). */
export interface StudioBridge {
  rememberState(): Promise<IpcResult<RememberState>>;
  login(credentials: Credentials, remember: boolean): Promise<IpcResult<SessionInfo>>;
  autoLogin(): Promise<IpcResult<SessionInfo>>;
  selectMosque(id: number): Promise<IpcResult<SessionInfo>>;
  logout(forget: boolean): Promise<IpcResult<null>>;
  whipOffer(sdp: string): Promise<IpcResult<{ answer: string; resource: string }>>;
  whipPatch(resource: string, fragment: string): Promise<IpcResult<null>>;
  whipClose(resource: string): Promise<IpcResult<null>>;
  /** Empêche la mise en veille de l'écran pendant un direct. */
  keepAwake(on: boolean): Promise<void>;
  version: string;
}

declare global {
  interface Window {
    studio: StudioBridge;
  }
}
