// Downloads the minimal macOS ffmpeg builds (arm64 and x64) that the app ships, checks them against the SHA-256 pinned
// below and stores them as build/ffmpeg/mac-arm64/ffmpeg and build/ffmpeg/mac-x64/ffmpeg: the app is built once per
// architecture and each build embeds only its own binary (electron-builder.yml: build/ffmpeg/mac-${arch}). Run by
// `npm run dist:mac` and by CI on macOS; nothing is committed (build/ffmpeg is git-ignored). electron-builder signs it
// with the rest of the bundle (hardened runtime).
//   node scripts/fetch-ffmpeg-mac.mjs [--force]
// Source: the "ffmpeg (macOS minimal build)" workflow, which runs scripts/build-ffmpeg-min.sh (ffmpeg + x264 from pinned,
// checksummed sources; GPL) and publishes the zips as a release. To update: run the workflow with publish=true, then
// replace RELEASE and the two hashes (printed by the workflow, also in <asset>.sha256). The application only runs
// ffmpeg as a separate process, it is not linked.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE = "ffmpeg-min-4";
const BASE = `https://github.com/thesadaproject/sada-studio/releases/download/${RELEASE}`;
const BUILDS = [
  { arch: "arm64", dir: "mac-arm64", sha256: "66a56acc29569f7f162319e18e59a7c1155a48aeffbdcfd03ac2324dff33dcb3" },
  { arch: "x64", dir: "mac-x64", sha256: "2e9a10ab81f85585d424474abd5ca69a017adce2bb5994eb40b8f70802730b7f" },
];

const force = process.argv.includes("--force");
const todo = BUILDS.filter((b) => force || !existsSync(join(root, "build", "ffmpeg", b.dir, "ffmpeg")));
if (todo.length === 0) {
  console.log("ffmpeg already there for arm64 and x64");
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), "sada-ffmpeg-"));
try {
  for (const b of todo) {
    const url = `${BASE}/ffmpeg-mac-${b.arch}.zip`;
    console.log(`Downloading ${url}…`);
    const r = await fetch(url, { redirect: "follow" });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    const zip = Buffer.from(await r.arrayBuffer());
    const actual = createHash("sha256").update(zip).digest("hex");
    if (actual !== b.sha256) throw new Error(`SHA-256 mismatch for ${url}: ${actual} (expected ${b.sha256})`);
    const dir = join(work, b.arch);
    mkdirSync(dir);
    const zipPath = join(dir, "ffmpeg.zip");
    writeFileSync(zipPath, zip);
    execFileSync("unzip", ["-q", zipPath, "-d", dir], { stdio: "inherit" });
    const out = join(root, "build", "ffmpeg", b.dir);
    mkdirSync(out, { recursive: true });
    copyFileSync(join(dir, "ffmpeg"), join(out, "ffmpeg"));
    copyFileSync(join(dir, "BUILD-INFO.txt"), join(out, "SOURCE.txt"));
    chmodSync(join(out, "ffmpeg"), 0o755);
    console.log(`ffmpeg ${b.arch} ready: ${out}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
