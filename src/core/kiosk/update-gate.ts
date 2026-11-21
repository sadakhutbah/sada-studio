/**
 * Une mise à jour redémarre l'application : jamais pendant un direct, ni juste avant un créneau.
 * `evaluateUpdateWindow` est pure ; `UpdateGate` la consulte jusqu'à ce que la fenêtre s'ouvre.
 */
export interface UpdateContext {
  /** La session émet (ou tente d'émettre) en ce moment. */
  sessionActive: boolean;
  /** Le serveur ou l'opérateur demande un direct. */
  wantLive: boolean;
  /** Début du prochain créneau (ms), ou null. */
  nextSlotAt: number | null;
  /** Un créneau est en cours. */
  slotRunning: boolean;
}

export const DEFAULT_UPDATE_MARGIN_MS = 30 * 60_000;

export type UpdateVerdict = { allowed: true } | { allowed: false; reason: string };

export function evaluateUpdateWindow(ctx: UpdateContext, now: number, marginMs = DEFAULT_UPDATE_MARGIN_MS): UpdateVerdict {
  if (ctx.sessionActive || ctx.wantLive) return { allowed: false, reason: "Un direct est en cours : la mise à jour attend la fin." };
  if (ctx.slotRunning) return { allowed: false, reason: "Un créneau est en cours : la mise à jour attend la fin." };
  if (ctx.nextSlotAt !== null && ctx.nextSlotAt - now <= marginMs) {
    return { allowed: false, reason: "Un direct est proche : la mise à jour attend la fin du créneau." };
  }
  return { allowed: true };
}

export interface UpdateGateOptions {
  context: () => UpdateContext;
  install: () => void;
  marginMs?: number;
  checkEveryMs?: number;
  now?: () => number;
}

export interface UpdateStatus {
  version: string;
  /** Pourquoi l'installation attend ; vide quand elle est lancée. */
  waiting: string;
  /** Download progress in percent while the update is still being fetched; null once it is ready. */
  downloading: number | null;
}

export class UpdateGate {
  private version: string | null = null;
  private waiting = "";
  private progress: number | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly listeners = new Set<(s: UpdateStatus | null) => void>();

  constructor(private readonly o: UpdateGateOptions) {}

  get status(): UpdateStatus | null {
    return this.version ? { version: this.version, waiting: this.waiting, downloading: this.progress } : null;
  }

  subscribe(fn: (s: UpdateStatus | null) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Download in progress: shown on screen, nothing is installed. */
  onProgress(version: string, percent: number): void {
    this.version = version;
    this.progress = Math.max(0, Math.min(100, Math.round(percent)));
    this.emit();
  }

  /** Une mise à jour est téléchargée : elle s'installe dès que la fenêtre le permet. */
  onDownloaded(version: string): void {
    this.version = version;
    this.progress = null;
    this.check();
    if (this.version && !this.timer) this.timer = setInterval(() => this.check(), this.o.checkEveryMs ?? 60_000);
  }

  check(): void {
    if (!this.version || this.progress !== null) return;
    const verdict = evaluateUpdateWindow(this.o.context(), (this.o.now ?? Date.now)(), this.o.marginMs);
    if (verdict.allowed) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.waiting = "";
      this.emit();
      this.o.install();
      return;
    }
    if (verdict.reason !== this.waiting) {
      this.waiting = verdict.reason;
      this.emit();
    }
  }

  dispose(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private emit(): void {
    for (const l of this.listeners) l(this.status);
  }
}
