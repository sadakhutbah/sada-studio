import { normalizeControlResult, type ControlRequest, type ControlResult } from "./actions";
import { CONTROL_TIMEOUT_MS } from "../audio/mute-sync";
import { t } from "../messages";

/**
 * Asks the application window to run an action (mic, web source, screen share: their state lives there) and waits for
 * its answer. `send` delivers the request (false when there is no window); an answer that never comes fails the request.
 */
export class RendererLink {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (r: ControlResult) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly send: (id: number, request: ControlRequest) => boolean,
    private readonly timeoutMs = CONTROL_TIMEOUT_MS,
  ) {}

  request(request: ControlRequest): Promise<ControlResult> {
    const id = this.nextId++;
    return new Promise<ControlResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, code: "timeout", message: t("control.timeout") });
      }, this.timeoutMs);
      this.pending.set(id, { resolve, timer });
      let delivered = false;
      try {
        delivered = this.send(id, request);
      } catch {
        delivered = false;
      }
      if (!delivered) this.answer(id, { ok: false, code: "ui_unavailable", message: t("control.uiUnavailable") });
    });
  }

  /** The window's answer (any shape: it is normalized). Unknown or late answers are ignored. */
  resolve(id: unknown, result: unknown): void {
    if (typeof id === "number") this.answer(id, normalizeControlResult(result));
  }

  private answer(id: number, result: ControlResult): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(result);
  }
}
