import { isSceneAction, type ControlRequest, type ControlResult } from "./actions";

export interface ControlDeps {
  /** Actions on the window (microphone, web source, screen share). */
  window(request: ControlRequest): Promise<ControlResult>;
  /** Scene changes, done in the main process through the Sada server. */
  scene(request: ControlRequest): Promise<ControlResult>;
}

/** The one place where an action, whoever asked for it (shortcut or API), is sent to the side that can run it. */
export class ControlService {
  constructor(private readonly deps: ControlDeps) {}

  async execute(request: ControlRequest): Promise<ControlResult> {
    try {
      return isSceneAction(request.action) ? await this.deps.scene(request) : await this.deps.window(request);
    } catch (e) {
      return { ok: false, code: "failed", message: e instanceof Error ? e.message : String(e) };
    }
  }
}
