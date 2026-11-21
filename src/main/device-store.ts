import { app, safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DeviceCredentials } from "../core/api/types";
import type { DeviceStore, Persisted, PersistStore } from "../core/kiosk/supervisor";

const deviceFile = () => join(app.getPath("userData"), "device.bin");
const stateFile = () => join(app.getPath("userData"), "kiosk-state.json");

/** Le chiffrement du système est disponible, et pas le repli en clair de Linux (« basic_text »). */
export function vaultAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  const backend = (safeStorage as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend?.();
  return backend !== "basic_text" && backend !== "unknown";
}

/** Écriture atomique : un plantage en plein écrit ne laisse jamais un fichier tronqué. */
function writeAtomic(path: string, data: string | Buffer, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, { mode });
  renameSync(tmp, path);
}

/**
 * Identité de l'appareil, chiffrée par safeStorage (DPAPI sous Windows). Sans coffre, elle reste en mémoire :
 * l'application fonctionne mais devra être appairée de nouveau au prochain lancement.
 */
export class SafeDeviceStore implements DeviceStore {
  private memory: DeviceCredentials | null = null;
  readonly persistent = vaultAvailable();

  constructor() {
    // Ancienne version : connexion par mot de passe mémorisée. Elle n'a plus lieu d'être : on l'efface.
    rmSync(join(app.getPath("userData"), "credentials.bin"), { force: true });
  }

  load(): DeviceCredentials | null {
    if (!this.persistent) return this.memory;
    try {
      if (!existsSync(deviceFile())) return null;
      const d = JSON.parse(safeStorage.decryptString(readFileSync(deviceFile()))) as DeviceCredentials;
      return d.baseUrl && d.deviceId && d.deviceSecret && d.mosque?.name ? d : null;
    } catch {
      // Fichier illisible (profil Windows recréé, clé DPAPI changée) : il faudra réappairer.
      return null;
    }
  }

  save(device: DeviceCredentials): void {
    this.memory = device;
    if (this.persistent) writeAtomic(deviceFile(), safeStorage.encryptString(JSON.stringify(device)));
  }

  clear(): void {
    this.memory = null;
    rmSync(deviceFile(), { force: true });
  }
}

/** « J'étais en direct » et directs écartés : rien de secret, un petit JSON. */
export class FilePersistStore implements PersistStore {
  load(): Persisted {
    try {
      const p = JSON.parse(readFileSync(stateFile(), "utf8")) as Partial<Persisted>;
      return { wasLive: p.wasLive === true, suppressed: Array.isArray(p.suppressed) ? p.suppressed.filter((k) => typeof k === "string") : [] };
    } catch {
      return { wasLive: false, suppressed: [] };
    }
  }

  save(p: Persisted): void {
    try {
      writeAtomic(stateFile(), JSON.stringify(p));
    } catch {
      // Disque plein ou verrouillé : la reprise sera simplement moins fine, le serveur reste maître.
    }
  }
}
