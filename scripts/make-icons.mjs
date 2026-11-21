// Regenerates every application icon from the Sada favicon (src/renderer/src/assets/favicon.svg).
// Run: npm run icons. Outputs are committed so that builds never depend on this script.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import png2icons from "png2icons";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(join(root, "src/renderer/src/assets/favicon.svg"));
const out = join(root, "build");
mkdirSync(join(out, "icons"), { recursive: true });

const render = (size) => sharp(svg, { density: Math.ceil((72 * size) / 1000) * 2 }).resize(size, size).png().toBuffer();

// macOS icons carry a transparent margin (the artwork is 824 px of a 1024 px canvas), as Apple's template requires.
async function macMaster() {
  const art = await render(824);
  return sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: art, top: 100, left: 100 }])
    .png()
    .toBuffer();
}

const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
for (const s of sizes) writeFileSync(join(out, "icons", `${s}x${s}.png`), await render(s));
const master = await render(1024);
writeFileSync(join(out, "icon.png"), master);
writeFileSync(join(out, "icon.icns"), png2icons.createICNS(await macMaster(), png2icons.BICUBIC, 0));
writeFileSync(join(out, "icon.ico"), png2icons.createICO(master, png2icons.BICUBIC, 0, false, true));
console.log("icons written to build/");
