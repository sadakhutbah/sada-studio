import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizeDelay, type AudioOffsetStore } from "../core/capture/types";
import { DEFAULT_CAPTURE_SETTINGS, parseSettings, type CaptureSettings } from "../core/capture/settings";

/** Node-only (no Electron import): the directory is given by the caller, tests use a temporary one. */

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  // Atomic: a crash mid-write never leaves a truncated file. Not 0600-critical, but it can hold camera credentials.
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Audio delay per sound card (key = backend:device), in a small JSON file of the application's data directory. */
export class FileAudioOffsetStore implements AudioOffsetStore {
  private readonly file: string;
  private cache: Record<string, number>;

  constructor(dir: string) {
    this.file = join(dir, "audio-offsets.json");
    const raw = readJson(this.file);
    this.cache = {};
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw)) if (typeof v === "number" && Number.isFinite(v)) this.cache[k] = normalizeDelay(v);
    }
  }

  get(deviceKey: string): number | undefined {
    return this.cache[deviceKey];
  }

  set(deviceKey: string, delayMs: number): void {
    this.cache[deviceKey] = normalizeDelay(delayMs);
    try {
      writeJson(this.file, this.cache);
    } catch {
      // Disk full or locked: the value stays in memory for this run.
    }
  }
}

/** Source choice, RTSP address and sound card of this device. */
export class FileCaptureSettingsStore {
  private readonly file: string;

  constructor(dir: string) {
    this.file = join(dir, "capture-settings.json");
  }

  load(): CaptureSettings {
    return parseSettings(readJson(this.file)) ?? DEFAULT_CAPTURE_SETTINGS;
  }

  save(s: CaptureSettings): void {
    writeJson(this.file, s);
  }
}
