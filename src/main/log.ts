import { app } from "electron";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX = 1_000_000;

/** Journal local, tourné à 1 Mo : de quoi comprendre un plantage sans jamais remplir le disque. Aucun secret n'y est écrit. */
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
      // Pas encore de fichier.
    }
    appendFileSync(file, `${line}\n`);
  } catch {
    // Journal indisponible : sans importance pour le fonctionnement.
  }
}
