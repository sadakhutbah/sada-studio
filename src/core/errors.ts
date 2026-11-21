/** Nature d'une erreur fatale d'émission : `conflict` = autre direct en cours ; `capture` = caméra ou micro. */
export type ErrorCode = "conflict" | "capture";

/** Erreur après laquelle réessayer tout de suite ne sert à rien (droits, caméra perdue, direct déjà en cours…). */
export class FatalError extends Error {
  /** `conflict` : un autre direct occupe la mosquée, on réessaiera plus tard, sans insister. */
  readonly code?: ErrorCode;
  constructor(message: string, code?: ErrorCode) {
    super(message);
    this.name = "FatalError";
    this.code = code;
  }
}

/** Réponse HTTP inattendue de Sada ; `status` 0 = serveur injoignable. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Le serveur ne reconnaît plus cet appareil (supprimé ou révoqué dans la console). */
export class DeviceRevokedError extends ApiError {
  constructor(message = "Cet appareil a été retiré de la console Sada.") {
    super(401, message);
    this.name = "DeviceRevokedError";
  }
}
