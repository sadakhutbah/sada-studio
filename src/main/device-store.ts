import { app, safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DeviceCredentials } from "../core/api/types";
import type { DeviceStore, Persisted, PersistStore } from "../core/kiosk/supervisor";

const deviceFile = () => join(app.getPath("userData"), "device.bin");
const stateFile = () => join(app.getPath("userData"), "kiosk-state.json");

/** System encryption is available, and not Linux's plain-text fallback ("basic_text"). */
export function vaultAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  const backend = (safeStorage as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend?.();
  return backend !== "basic_text" && backend !== "unknown";
}

/** Atomic write: a crash mid-write never leaves a truncated file. */
function writeAtomic(path: string, data: string | Buffer, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, { mode });
  renameSync(tmp, path);
}

/**
 * Device identity, encrypted by safeStorage (DPAPI on Windows). Without a vault it stays in memory:
 * the application works but will have to be paired again at the next launch.
 */
export class SafeDeviceStore implements DeviceStore {
  private memory: DeviceCredentials | null = null;
  readonly persistent = vaultAvailable();

  constructor() {
    // Old version: stored password login. It is obsolete: erase it.
    rmSync(join(app.getPath("userData"), "credentials.bin"), { force: true });
  }

  load(): DeviceCredentials | null {
    if (!this.persistent) return this.memory;
    try {
      if (!existsSync(deviceFile())) return null;
      const d = JSON.parse(safeStorage.decryptString(readFileSync(deviceFile()))) as DeviceCredentials;
      return d.baseUrl && d.deviceId && d.deviceSecret && d.mosque?.name ? d : null;
    } catch {
      // Unreadable file (Windows profile recreated, DPAPI key changed): pairing must be redone.
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

/** "I was live" and dismissed lives: nothing secret, a small JSON. */
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
      // Disk full or locked: resuming will just be less precise, the server remains the master.
    }
  }
}
