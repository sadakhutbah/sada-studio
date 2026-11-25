import type { InputAudioMixer } from "./mixer";

/**
 * Toggles the local mute, then tells the server. If the server does not take it, the local state goes back
 * (what the operator sees must be what is on air) and the error is returned; `null` when all went well.
 */
export async function toggleMuteSynced(mixer: InputAudioMixer, push: (muted: boolean) => Promise<unknown>): Promise<Error | null> {
  const next = mixer.toggleMute();
  try {
    await push(next);
    return null;
  } catch (e) {
    // Only roll back if nothing changed the state meanwhile (another toggle).
    if (mixer.isMuted() === next) mixer.setMuted(!next);
    return e instanceof Error ? e : new Error(String(e));
  }
}
