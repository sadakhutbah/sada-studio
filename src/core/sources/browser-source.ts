import { t } from "../messages";
import type {
  BrowserSourceConfig,
  BrowserSourceCorner,
  BrowserSourceLayout,
  BrowserSourceMode,
  BrowserSourceSize,
} from "./types";

export const MAX_BROWSER_SOURCE_URL_LENGTH = 2048;

export const DEFAULT_BROWSER_SOURCE: BrowserSourceConfig = {
  url: "",
  visible: false,
  mode: "overlay",
  corner: "br",
  size: "md",
};

export interface OverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const SIZE_WIDTH_RATIO: Record<BrowserSourceSize, number> = {
  sm: 0.26,
  md: 0.38,
  lg: 0.54,
};

const BLOCKED_SUFFIXES = [".localhost", ".local", ".localdomain", ".internal", ".intranet", ".lan", ".home.arpa"];

function ipv4Octets(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

function isPrivateIpv4([a, b, c]: number[]): boolean {
  return (
    a === 0 || // "this" network, 0.0.0.0
    a === 10 ||
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved
  );
}

/** The eight 16-bit groups of an IPv6 address (no brackets, no zone), or null when it is not one. */
function ipv6Groups(host: string): number[] | null {
  let h = host;
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (tail) {
    const o = ipv4Octets(tail[1]!);
    if (!o) return null;
    h = `${h.slice(0, -tail[1]!.length)}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":"));
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...rest];
  const groups = all.map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
  return groups.length === 8 && groups.every((g) => !Number.isNaN(g)) ? groups : null;
}

function isPrivateIpv6(g: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g7 === 1) return true; // ::1
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  const embedded = [g6 >> 8, g6 & 255, g7 >> 8, g7 & 255];
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible), 64:ff9b::/96 (NAT64): judged by the IPv4 inside.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) return isPrivateIpv4(embedded);
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isPrivateIpv4(embedded);
  if (g0 === 0x2002) return isPrivateIpv4([g1 >> 8, g1 & 255, g2 >> 8, g2 & 255]); // 6to4
  return false;
}

/**
 * True for hosts a web source must never reach: localhost and local names, loopback, private ranges
 * (10/8, 172.16/12, 192.168/16, fc00::/7), link-local (169.254/16, fe80::/10) and the other non-public ranges.
 * Takes a `URL.hostname` (brackets around IPv6 allowed) or a bare IP address.
 */
export function isPrivateOrLocalHost(hostname: string): boolean {
  let h = hostname.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  h = h.replace(/\.$/, "");
  if (!h) return true;
  if (h.includes(":")) {
    const groups = ipv6Groups(h.split("%")[0]!);
    return groups ? isPrivateIpv6(groups) : true;
  }
  const v4 = ipv4Octets(h);
  if (v4) return isPrivateIpv4(v4);
  if (h === "localhost" || BLOCKED_SUFFIXES.some((s) => h.endsWith(s))) return true;
  return !h.includes("."); // a single-label name resolves on the local network
}

/**
 * Validates and normalizes a Browser Source URL.
 * Only public http:// and https:// URLs are allowed: no file://, javascript:, data:, and no address of this
 * computer or of a private / link-local network (the page is rendered on the broadcast machine).
 */
export function validateBrowserSourceUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(t("browser.urlEmpty"));
  }
  if (trimmed.length > MAX_BROWSER_SOURCE_URL_LENGTH) {
    throw new Error(t("browser.urlTooLong"));
  }
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || /^(javascript|data|file|blob|about|mailto):/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(t("browser.urlInvalid"));
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(t("browser.urlScheme"));
  }
  if (isPrivateOrLocalHost(parsed.hostname)) {
    throw new Error(t("browser.urlPrivate"));
  }
  return parsed.toString();
}

/**
 * Whether the hidden web-source window may issue a request: public http(s) / ws(s) hosts, plus the inline `data:`,
 * `blob:` and `about:blank` pages. Everything else (file:, ftp:, chrome:, devtools:…) and every private host is refused.
 */
export function isAllowedBrowserRequest(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  switch (u.protocol) {
    case "http:":
    case "https:":
    case "ws:":
    case "wss:":
      return !isPrivateOrLocalHost(u.hostname);
    case "data:":
    case "blob:":
      return true;
    case "about:":
      return u.href === "about:blank";
    default:
      return false;
  }
}

/**
 * Computes the destination rectangle of the browser source on the output canvas.
 */
export function computeBrowserSourceRect(
  canvasWidth: number,
  canvasHeight: number,
  layout: BrowserSourceLayout,
  sourceAspect = 16 / 9,
): OverlayRect {
  const w = Math.max(1, Math.round(canvasWidth));
  const h = Math.max(1, Math.round(canvasHeight));
  if (layout.mode === "fullscreen") {
    return { x: 0, y: 0, width: w, height: h };
  }

  const ratio = SIZE_WIDTH_RATIO[layout.size] ?? SIZE_WIDTH_RATIO.md;
  const safeAspect = sourceAspect > 0.1 && sourceAspect < 10 ? sourceAspect : 16 / 9;
  const margin = Math.round(Math.min(w, h) * 0.03);
  const maxW = Math.max(1, w - margin * 2);
  const maxH = Math.max(1, h - margin * 2);

  let boxW = Math.min(maxW, Math.round(w * ratio));
  let boxH = Math.round(boxW / safeAspect);
  if (boxH > maxH) {
    boxH = maxH;
    boxW = Math.min(maxW, Math.round(boxH * safeAspect));
  }

  const isRight = layout.corner === "tr" || layout.corner === "br";
  const isBottom = layout.corner === "bl" || layout.corner === "br";
  const x = isRight ? w - margin - boxW : margin;
  const y = isBottom ? h - margin - boxH : margin;
  return { x, y, width: boxW, height: boxH };
}

export function normalizeBrowserSourceConfig(input: Partial<BrowserSourceConfig> | null | undefined): BrowserSourceConfig {
  const mode: BrowserSourceMode = input?.mode === "fullscreen" ? "fullscreen" : "overlay";
  const corner: BrowserSourceCorner =
    input?.corner === "tl" || input?.corner === "tr" || input?.corner === "bl" || input?.corner === "br"
      ? input.corner
      : DEFAULT_BROWSER_SOURCE.corner;
  const size: BrowserSourceSize =
    input?.size === "sm" || input?.size === "md" || input?.size === "lg" ? input.size : DEFAULT_BROWSER_SOURCE.size;
  return {
    url: typeof input?.url === "string" ? input.url : "",
    visible: Boolean(input?.visible),
    mode,
    corner,
    size,
  };
}

/** Chromium's ERR_ABORTED: the load was superseded (redirect, new navigation, stop), not a failure of the page. */
export const ERR_ABORTED = -3;

/** `did-fail-load`: only a real failure of the main frame counts; sub-frames and cancelled loads are ignored. */
export function isReportableLoadFailure(errorCode: number, isMainFrame: boolean): boolean {
  return isMainFrame && errorCode !== ERR_ABORTED;
}

/** A rejection of `loadURL` (it rejects on every `did-fail-load`, cancellations included): is it a real failure? */
export function isReportableLoadRejection(e: unknown): boolean {
  const err = e as { errno?: unknown; code?: unknown; message?: unknown } | null;
  if (err && err.errno === ERR_ABORTED) return false;
  if (err && err.code === "ERR_ABORTED") return false;
  return !(err && typeof err.message === "string" && /\bERR_ABORTED\b|\(-3\)/.test(err.message));
}
