import { app, safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Credentials } from "../core/api/types";

const file = () => join(app.getPath("userData"), "credentials.bin");

/** Le chiffrement du système est disponible, et pas le repli en clair de Linux (« basic_text »). */
export function vaultAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  const backend = (safeStorage as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend?.();
  return backend !== "basic_text" && backend !== "unknown";
}

/** Mémorise la connexion, chiffrée par safeStorage. Le mot de passe n'est jamais écrit en clair. */
export function saveCredentials(c: Credentials): void {
  if (!vaultAvailable()) throw new Error("Aucun coffre sécurisé sur ce système : connexion non mémorisée.");
  mkdirSync(dirname(file()), { recursive: true });
  writeFileSync(file(), safeStorage.encryptString(JSON.stringify(c)), { mode: 0o600 });
}

export function loadCredentials(): Credentials | null {
  if (!existsSync(file()) || !vaultAvailable()) return null;
  try {
    const c = JSON.parse(safeStorage.decryptString(readFileSync(file()))) as Credentials;
    return c.baseUrl && c.username && c.password ? c : null;
  } catch {
    return null;
  }
}

export function forgetCredentials(): void {
  rmSync(file(), { force: true });
}
