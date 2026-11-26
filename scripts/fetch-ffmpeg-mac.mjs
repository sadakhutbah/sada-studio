// Downloads the static macOS ffmpeg builds (arm64 and x64) that the app ships, checks them against the published
// SHA-256 and stores them as build/ffmpeg/mac-arm64/ffmpeg and build/ffmpeg/mac-x64/ffmpeg: the app is built once per
// architecture and each build embeds only its own binary (electron-builder.yml: build/ffmpeg/mac-${arch}). Run by
// `npm run dist:mac` and by CI on macOS; nothing is committed (build/ffmpeg is git-ignored). electron-builder signs it
// with the rest of the bundle (hardened runtime).
//   node scripts/fetch-ffmpeg-mac.mjs [--force]
// Source: https://ffmpeg.martin-riedl.de (static GPL build with avfoundation and RTSP). The application only runs it as
// a separate process, it is not linked.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "https://ffmpeg.martin-riedl.de/download/macos";
// Pinned release builds (ffmpeg 9.1); bump both together. `arch` is the name lipo reports; `dir` is electron-builder's.
const BUILDS = [
  { arch: "arm64", dir: "mac-arm64", path: "arm64/1795207104_9.1" },
  { arch: "x86_64", dir: "mac-x64", path: "amd64/1795212433_9.1" },
];

const force = process.argv.includes("--force");
const todo = BUILDS.filter((b) => force || !existsSync(join(root, "build", "ffmpeg", b.dir, "ffmpeg")));
if (todo.length === 0) {
  console.log("ffmpeg already there for arm64 and x64");
  process.exit(0);
}

const get = async (url) => {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
};

const work = mkdtempSync(join(tmpdir(), "sada-ffmpeg-"));
try {
  for (const b of todo) {
    const url = `${BASE}/${b.path}/ffmpeg.zip`;
    console.log(`Downloading ${url}…`);
    const zip = await get(url);
    const expected = (await get(`${url}.sha256`)).toString("utf8").trim().split(/\s+/)[0];
    const actual = createHash("sha256").update(zip).digest("hex");
    if (!/^[0-9a-f]{64}$/.test(expected ?? "")) throw new Error(`No checksum published for ${url}`);
    if (actual !== expected) throw new Error(`SHA-256 mismatch for ${url}: ${actual} (expected ${expected})`);
    const dir = join(work, b.arch);
    mkdirSync(dir);
    const zipPath = join(dir, "ffmpeg.zip");
    writeFileSync(zipPath, zip);
    execFileSync("unzip", ["-q", zipPath, "-d", dir], { stdio: "inherit" });
    const bin = join(dir, "ffmpeg");
    if (process.platform === "darwin") {
      const archs = execFileSync("lipo", ["-archs", bin]).toString().trim();
      if (archs !== b.arch) throw new Error(`${url} is ${archs}, expected ${b.arch}`);
    }
    const out = join(root, "build", "ffmpeg", b.dir);
    mkdirSync(out, { recursive: true });
    copyFileSync(bin, join(out, "ffmpeg"));
    chmodSync(join(out, "ffmpeg"), 0o755);
    writeFileSync(
      join(out, "SOURCE.txt"),
      `${url}\nsha256 ${actual}\nFFmpeg is GPL: https://ffmpeg.org/ and https://ffmpeg.martin-riedl.de\n`,
    );
    console.log(`ffmpeg ${b.arch} ready: ${out}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
