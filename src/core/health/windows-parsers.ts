/**
 * Parsers for `reg query` and `powercfg` output (Windows). Pure functions, independent of the system language:
 * they rely neither on labels nor on accents, only on value names and numbers.
 */

function regValue(output: string, name: string): string | null {
  const m = new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+?)\\s*$`, "im").exec(output);
  return m ? m[1] : null;
}

const toNumber = (v: string | null): number | null => {
  if (v === null) return null;
  const n = /^0x/i.test(v) ? parseInt(v, 16) : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon : AutoAdminLogon = 1 when the session opens without a password. */
export function parseAutoLogon(output: string): boolean | null {
  const v = regValue(output, "AutoAdminLogon");
  return v === null ? null : v.trim() === "1";
}

/** HKLM\\SOFTWARE\\Microsoft\\WindowsUpdate\\UX\\Settings : ActiveHoursStart / ActiveHoursEnd (whole hours 0–23). */
export function parseActiveHours(output: string): { start: number; end: number } | null {
  const start = toNumber(regValue(output, "ActiveHoursStart"));
  const end = toNumber(regValue(output, "ActiveHoursEnd"));
  return start === null || end === null ? null : { start, end };
}

/** `powercfg /query … STANDBYIDLE`: the last two hexadecimal values are AC then battery, in seconds (0 = never). */
export function parseSleepTimeouts(output: string): { acSeconds: number; dcSeconds: number } | null {
  const hex = [...output.matchAll(/0x[0-9a-f]+/gi)].map((m) => parseInt(m[0], 16));
  if (hex.length < 2) return null;
  return { acSeconds: hex[hex.length - 2], dcSeconds: hex[hex.length - 1] };
}
