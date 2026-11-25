import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { normalizeControlSettings, TOKEN_HEX_LENGTH, type ControlSettings } from "../core/control/settings";

export const newToken = (): string => randomBytes(TOKEN_HEX_LENGTH / 2).toString("hex");

/** Shortcuts and local API settings, in a small JSON of the user data directory (readable by the user only: it holds the API token). */
export class ControlStore {
  private readonly file: string;

  constructor(userData: string) {
    this.file = join(userData, "control-settings.json");
  }

  load(): ControlSettings {
    let raw: unknown = null;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      /* first launch or unreadable file: defaults, and a new token */
    }
    return normalizeControlSettings(raw, newToken);
  }

  save(settings: ControlSettings): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
      chmodSync(this.file, 0o600);
    } catch {
      // Disk full or locked: the settings hold for this run only.
    }
  }
}
