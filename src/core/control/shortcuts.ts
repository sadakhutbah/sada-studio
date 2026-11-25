import type { ShortcutAction } from "./actions";
import { SHORTCUT_ACTIONS } from "./actions";

/** `registered`; `disabled`: no accelerator; `failed`: the system refused it (taken by another application); `duplicate`: another action has it. */
export type ShortcutStatus = "registered" | "disabled" | "failed" | "duplicate";

/** What the registry needs from Electron's `globalShortcut` (replaceable in tests). */
export interface ShortcutBackend {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

/** Registers the configured global shortcuts, reports which ones the system accepted, and removes them all on demand. */
export class ShortcutRegistry {
  private active: string[] = [];

  constructor(
    private readonly backend: ShortcutBackend,
    private readonly onAction: (action: ShortcutAction) => void,
  ) {}

  /** Replaces what was registered by `shortcuts`. */
  apply(shortcuts: Record<ShortcutAction, string>): Record<ShortcutAction, ShortcutStatus> {
    this.dispose();
    const status = {} as Record<ShortcutAction, ShortcutStatus>;
    const taken = new Set<string>();
    for (const action of SHORTCUT_ACTIONS) {
      const accelerator = shortcuts[action];
      if (!accelerator) {
        status[action] = "disabled";
        continue;
      }
      const key = accelerator.toLowerCase();
      if (taken.has(key)) {
        status[action] = "duplicate";
        continue;
      }
      let ok = false;
      try {
        ok = this.backend.register(accelerator, () => this.onAction(action));
      } catch {
        ok = false;
      }
      status[action] = ok ? "registered" : "failed";
      if (ok) {
        taken.add(key);
        this.active.push(accelerator);
      }
    }
    return status;
  }

  dispose(): void {
    for (const a of this.active) {
      try {
        this.backend.unregister(a);
      } catch {
        /* already gone */
      }
    }
    this.active = [];
  }
}
