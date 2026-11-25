import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SOURCE_EVENT_CHANNELS, SOURCE_INVOKE_CHANNELS, SOURCE_SEND_CHANNELS } from "../src/main/ipc-guards";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const preload = read("src/preload/index.ts");
const mainFiles = ["src/main/ipc.ts", "src/main/sources.ts", "src/main/projector.ts"].map(read).join("\n");

const all = (re: RegExp, text: string) => [...text.matchAll(re)].map((m) => m[1]!);

describe("IPC channel whitelist", () => {
  it("exposes the local-sources channels in the preload, one method each, and nothing else for them", () => {
    const invoked = all(/ipcRenderer\.invoke\("(sources:[^"]+)"/g, preload);
    const sent = all(/ipcRenderer\.send\("(sources:[^"]+)"/g, preload);
    const listened = all(/ipcRenderer\.(?:on|removeListener)\("(sources:[^"]+)"/g, preload);
    expect(new Set(invoked)).toEqual(new Set(SOURCE_INVOKE_CHANNELS));
    expect(new Set(sent)).toEqual(new Set(SOURCE_SEND_CHANNELS));
    expect(new Set(listened)).toEqual(new Set(SOURCE_EVENT_CHANNELS));
  });

  it("has a main-process handler for every channel the preload invokes or sends (no dead call, no unlisted handler)", () => {
    const handled = new Set(all(/ipcMain\.(?:handle|on)\("([^"]+)"/g, mainFiles));
    // `handle("sources:...")` helper of sources.ts registers through ipcMain.handle.
    for (const c of all(/\bhandle\("(sources:[^"]+)"/g, mainFiles)) handled.add(c);
    for (const c of [...all(/ipcRenderer\.invoke\("([^"]+)"/g, preload), ...all(/ipcRenderer\.send\("([^"]+)"/g, preload)]) {
      expect(handled.has(c), `no handler for ${c}`).toBe(true);
    }
    const sourceHandlers = [...handled].filter((c) => c.startsWith("sources:"));
    expect(new Set(sourceHandlers)).toEqual(new Set([...SOURCE_INVOKE_CHANNELS, ...SOURCE_SEND_CHANNELS]));
  });

  it("never exposes ipcRenderer itself", () => {
    expect(preload).not.toMatch(/exposeInMainWorld\("[^"]+",\s*ipcRenderer/);
    expect(preload).not.toMatch(/ipcRenderer\s*[,}]\s*$/m);
  });

  it("checks the sender of every local-sources request", () => {
    const sources = read("src/main/sources.ts");
    expect(sources).toMatch(/fromMain\(e\)/);
    // Frames go to the application window only, never to every window.
    expect(sources).not.toMatch(/getAllWindows/);
  });
});
