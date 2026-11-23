import { useEffect, useRef } from "react";

/** Content of the projector window: only the preview video on black. Escape or a double-click closes it. */
export function ProjectorScreen() {
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    let pc: RTCPeerConnection | null = null;
    const off = window.studio.projector.onSignal((m) => {
      void (async () => {
        if (m.kind === "offer") {
          pc?.close();
          const p = new RTCPeerConnection();
          pc = p;
          p.onicecandidate = (e) => e.candidate && window.studio.projector.signal({ kind: "ice", candidate: e.candidate.toJSON() });
          p.ontrack = (e) => {
            if (video.current) video.current.srcObject = e.streams[0] ?? new MediaStream([e.track]);
          };
          await p.setRemoteDescription({ type: "offer", sdp: m.sdp });
          await p.setLocalDescription(await p.createAnswer());
          window.studio.projector.signal({ kind: "answer", sdp: p.localDescription?.sdp ?? "" });
        } else if (m.kind === "ice") {
          await pc?.addIceCandidate(m.candidate).catch(() => undefined);
        }
      })();
    });
    window.studio.projector.signal({ kind: "ready" });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void window.studio.projector.close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      off();
      pc?.close();
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div className="fixed inset-0 cursor-none bg-black" onDoubleClick={() => void window.studio.projector.close()}>
      <video ref={video} autoPlay muted playsInline className="size-full bg-black object-contain" />
    </div>
  );
}
