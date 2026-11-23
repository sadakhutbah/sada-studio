// Downloads the static Windows ffmpeg that the installer ships (build/ffmpeg/win/ffmpeg.exe), checked against the
// SHA-256 published next to it. Run by `npm run dist:win`; nothing is committed (build/ffmpeg is git-ignored).
//   node scripts/fetch-ffmpeg-win.mjs [--force]
// Source: BtbN/FFmpeg-Builds (GPL build: libx264 and the dshow/rtsp inputs the capture needs). The application only
// runs it as a separate process, it is not linked.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "build", "ffmpeg", "win");
const target = join(out, "ffmpeg.exe");
const BASE = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest";
const ZIP = "ffmpeg-n8.1-latest-win64-gpl-8.1.zip";

if (existsSync(target) && !process.argv.includes("--force")) {
  console.log(`ffmpeg already there: ${target}`);
  process.exit(0);
}

const get = async (url) => {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
};

const work = mkdtempSync(join(tmpdir(), "sada-ffmpeg-"));
try {
  console.log(`Downloading ${ZIP}…`);
  const zip = await get(`${BASE}/${ZIP}`);
  const sums = (await get(`${BASE}/checksums.sha256`)).toString("utf8");
  const expected = sums.split(/\r?\n/).map((l) => l.trim().split(/\s+/)).find((p) => p[1]?.replace(/^\*/, "") === ZIP)?.[0];
  if (!expected) throw new Error(`No checksum published for ${ZIP}`);
  const actual = createHash("sha256").update(zip).digest("hex");
  if (actual !== expected) throw new Error(`SHA-256 mismatch for ${ZIP}: ${actual} (expected ${expected})`);
  const zipPath = join(work, ZIP);
  writeFileSync(zipPath, zip);
  // bsdtar (Windows 10+, macOS) reads zip; elsewhere unzip.
  try {
    execFileSync("tar", ["-xf", zipPath, "-C", work], { stdio: "inherit" });
  } catch {
    execFileSync("unzip", ["-q", zipPath, "-d", work], { stdio: "inherit" });
  }
  const inner = readdirSync(work).find((n) => n.startsWith("ffmpeg-") && !n.endsWith(".zip"));
  if (!inner) throw new Error("Unexpected archive layout");
  mkdirSync(out, { recursive: true });
  copyFileSync(join(work, inner, "bin", "ffmpeg.exe"), target);
  copyFileSync(join(work, inner, "LICENSE.txt"), join(out, "LICENSE.txt"));
  writeFileSync(join(out, "SOURCE.txt"), `${BASE}/${ZIP}\nsha256 ${actual}\nFFmpeg is GPL: https://ffmpeg.org/ and https://github.com/BtbN/FFmpeg-Builds\n`);
  console.log(`ffmpeg.exe ready (sha256 of archive ${actual})`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
