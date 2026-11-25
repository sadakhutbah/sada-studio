/**
 * Two-step removal of a source: asking opens a confirmation, only confirming removes it. Hiding or showing a source
 * never goes through here (it is reversible and instant, like in OBS); removing drops the page and what it stored.
 */
export type RemovalPhase = "idle" | "confirming";
export type RemovalEvent = "ask" | "confirm" | "cancel";

export interface RemovalStep {
  phase: RemovalPhase;
  /** The caller must remove the source now. */
  remove: boolean;
}

export function removalStep(phase: RemovalPhase, event: RemovalEvent): RemovalStep {
  if (event === "ask") return { phase: "confirming", remove: false };
  // A confirmation without a pending question (stale click, double click) removes nothing.
  if (event === "confirm") return { phase: "idle", remove: phase === "confirming" };
  return { phase: "idle", remove: false };
}
