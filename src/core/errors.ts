/** Erreur après laquelle réessayer ne sert à rien (droits, entrée non « push », caméra perdue…). */
export class FatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalError";
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
