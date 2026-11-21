// macOS only, development only: the Dock and the menu bar take their name and icon from the stock Electron.app bundle,
// which app.setName() cannot change. Rewrites that bundle (inside node_modules) so `npm run dev` shows Sada Studio.
// Runs from `postinstall`; harmless elsewhere (does nothing off macOS or when electron is not installed).
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function brandPlist(xml, name) {
  const set = (src, key) => src.replace(new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`), `$1${name}$2`);
  let out = set(xml, "CFBundleName");
  out = /<key>CFBundleDisplayName<\/key>/.test(out)
    ? set(out, "CFBundleDisplayName")
    : out.replace("</dict>", `\t<key>CFBundleDisplayName</key>\n\t<string>${name}</string>\n</dict>`);
  return out;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform === "darwin" && process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = join(root, "node_modules/electron/dist/Electron.app/Contents");
  const plist = join(app, "Info.plist");
  if (existsSync(plist)) {
    writeFileSync(plist, brandPlist(readFileSync(plist, "utf8"), "Sada Studio"));
    copyFileSync(join(root, "build/icon.icns"), join(app, "Resources/electron.icns"));
    console.log("Dev Electron.app branded as Sada Studio.");
  }
}
