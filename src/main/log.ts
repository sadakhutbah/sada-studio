import { app } from "electron";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX = 1_000_000;

/** Local log, rotated at 1 MB: enough to understand a crash without ever filling the disk. No secret is written to it. */
export function log(message: string): void {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  try {
    const dir = app.getPath("logs");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "studio.log");
    try {
      if (statSync(file).size > MAX) renameSync(file, `${file}.old`);
    } catch {
      // No file yet.
    }
    appendFileSync(file, `${line}\n`);
  } catch {
    // Log unavailable: irrelevant for operation.
  }
}
