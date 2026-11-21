/**
 * Where the application looks for updates. The default feed is baked into the installer by electron-builder
 * (`publish` in electron-builder.yml, a plain static HTTP directory: no token ever ships with the app).
 * An operator can override it per machine without rebuilding: environment variable first, then the
 * `update.json` file in the user-data directory.
 */
export interface UpdateFeed {
  /** Base URL of a directory serving latest.yml / latest-mac.yml / latest-linux.yml and the installers. */
  url: string;
  /** Release channel: "latest" (stable) or e.g. "beta" (reads beta.yml). */
  channel: string;
  source: "environment" | "file" | "built-in";
}

export interface UpdateFeedInputs {
  env: Record<string, string | undefined>;
  /** Parsed content of update.json, or undefined when absent or unreadable. */
  file: unknown;
}

function cleanUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const u = new URL(value.trim());
    // Plain http is tolerated only on loopback (local tests); real feeds must be https.
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function cleanChannel(value: unknown): string | null {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,30}$/.test(value.trim()) ? value.trim() : null;
}

/** Returns the override, or null to keep the feed baked into the installer. */
export function resolveUpdateFeed({ env, file }: UpdateFeedInputs): UpdateFeed | null {
  const f = file && typeof file === "object" ? (file as Record<string, unknown>) : {};
  const envUrl = cleanUrl(env.SADA_STUDIO_UPDATE_URL);
  if (envUrl) return { url: envUrl, channel: cleanChannel(env.SADA_STUDIO_UPDATE_CHANNEL) ?? cleanChannel(f.channel) ?? "latest", source: "environment" };
  const fileUrl = cleanUrl(f.url);
  if (fileUrl) return { url: fileUrl, channel: cleanChannel(f.channel) ?? "latest", source: "file" };
  return null;
}
