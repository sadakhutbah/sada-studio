import type { WhipSignaling } from "../transport/whip";

export interface Credentials {
  /** Adresse de l'instance Sada, ex. https://console.sadakhutbah.org */
  baseUrl: string;
  username: string;
  password: string;
}

export interface MosqueInfo {
  id: number;
  slug: string;
  name: string;
}

export interface MosqueChoice extends MosqueInfo {
  access: "member" | "support";
}

/** Ce que Sada rend après connexion ou choix de la mosquée (sous-ensemble de la session de la console). */
export interface SessionInfo {
  user: { id: number; name: string; role: string; role_label: string; permissions: string[]; operator?: boolean };
  mosque: MosqueInfo | null;
  mosques: MosqueChoice[];
  csrf: string;
}

export type StreamKind = "khutba" | "dars";

export interface StreamMeta {
  kind: StreamKind;
  title: string;
}

/**
 * Surface de l'API Sada utilisée par le studio. L'application ne dépend que de cette interface :
 * la forme finale des points d'accès (branche feat/studio-whip-auth) ne touche que `SadaHttpApi`.
 */
export interface StudioApi {
  login(credentials: Credentials): Promise<SessionInfo>;
  selectMosque(mosqueId: number): Promise<SessionInfo>;
  logout(): Promise<void>;
  /** Annonce le type et le titre du direct. Sans effet tant que Sada n'expose pas de point d'accès pour cela. */
  announce(meta: StreamMeta): Promise<void>;
  readonly whip: WhipSignaling;
}
