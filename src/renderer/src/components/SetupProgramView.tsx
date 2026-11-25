import { useEffect, useRef } from "react";
import { WhepPlayer } from "@core/transport/whep";
import { ApiError } from "@core/errors";
import { t } from "@core/messages";
import { PHASE_MESSAGE, badge, retryDelayMs, shouldPlay, type SetupPhase } from "@core/setup/view";
import type { SetupState } from "@core/api/types";
import { whepSignaling } from "../bridge";

/**
 * The programme as the orchestrator composes it (WHEP through the back office, the device's credential): what
 * would be broadcast, with the mosque's templates, texts, logo and overlays. While there is no picture, a readable
 * waiting text says why (the orchestrator waking, starting, unreachable…).
 */
export function SetupProgramView({
  phase,
  state,
  onPlaying,
}: {
  phase: SetupPhase;
  state: SetupState | null;
  onPlaying: (playing: boolean) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const play = shouldPlay(phase);
  const message = PHASE_MESSAGE[phase];

  useEffect(() => {
    if (!play) return;
    const el = video.current;
    let alive = true;
    let player: WhepPlayer | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const connect = async () => {
      const p = new WhepPlayer({ signaling: whepSignaling });
      player = p;
      p.onStream((stream) => {
        if (video.current) video.current.srcObject = stream;
      });
      p.onLost(() => {
        if (!alive) return;
        onPlaying(false);
        timer = setTimeout(() => void connect(), retryDelayMs(0));
      });
      try {
        await p.connect();
        if (!alive) return void p.close();
        attempt = 0;
        onPlaying(true);
      } catch (e) {
        if (!alive) return;
        onPlaying(false);
        // 404: the orchestrator has not published the programme yet; anything else is retried the same way.
        const waiting = e instanceof ApiError && e.status === 404;
        timer = setTimeout(() => void connect(), retryDelayMs(waiting ? attempt++ : 2));
      }
    };
    void connect();
    return () => {
      alive = false;
      clearTimeout(timer);
      void player?.close();
      if (el) el.srcObject = null;
      onPlaying(false);
    };
  }, [play, onPlaying]);

  return (
    <div className="relative aspect-video overflow-hidden bg-night" data-testid="setup-program" data-phase={phase}>
      <video ref={video} autoPlay muted playsInline className="size-full object-contain" />
      {message && (
        <div className="absolute inset-0 grid place-content-center gap-2 bg-night/90 px-8 text-center" role="status">
          <p className="m-0 text-[1.05rem] leading-snug text-night-ink">{t(message)}</p>
        </div>
      )}
      {phase === "watching" && (
        <span
          className={`absolute left-2 top-2 rounded-full px-3 py-0.5 text-[0.78rem] font-semibold ${state?.live ? "bg-live text-white" : "bg-black/60 text-night-ink"}`}
        >
          {t(badge(state))}
        </span>
      )}
    </div>
  );
}
