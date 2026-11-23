import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectorDisplay } from "@shared/ipc";
import { fill, fr } from "../strings";
import { Btn, Card, Kicker } from "../ui";
import type { Prefs } from "../prefs";

interface Props {
  stream: MediaStream | null;
  onAir: boolean;
  prefs: Prefs;
  setPrefs: (p: Prefs) => void;
}

/** Projector mode controls (operator window) and video feed to the projector window over a local WebRTC link. */
export function ProjectorPanel({ stream, onAir, prefs, setPrefs }: Props) {
  const [displays, setDisplays] = useState<ProjectorDisplay[]>([]);
  const [open, setOpen] = useState(false);
  const pc = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef(stream);
  useEffect(() => {
    streamRef.current = stream;
  }, [stream]);

  const chosen = displays.find((d) => d.id === prefs.projectorDisplay) ?? displays.find((d) => d.external) ?? displays[0];

  useEffect(() => {
    void window.studio.projector.displays().then(setDisplays);
    void window.studio.projector.isOpen().then(setOpen);
    return window.studio.projector.onState(setOpen);
  }, []);

  const offer = useCallback(async () => {
    pc.current?.close();
    pc.current = null;
    const s = streamRef.current;
    if (!s) return;
    const p = new RTCPeerConnection();
    pc.current = p;
    p.onicecandidate = (e) => e.candidate && window.studio.projector.signal({ kind: "ice", candidate: e.candidate.toJSON() });
    for (const t of s.getVideoTracks()) p.addTrack(t, s);
    await p.setLocalDescription(await p.createOffer());
    window.studio.projector.signal({ kind: "offer", sdp: p.localDescription?.sdp ?? "" });
  }, []);

  useEffect(() => {
    return window.studio.projector.onSignal((m) => {
      if (m.kind === "ready") void offer();
      else if (m.kind === "answer") void pc.current?.setRemoteDescription({ type: "answer", sdp: m.sdp });
      else if (m.kind === "ice") void pc.current?.addIceCandidate(m.candidate).catch(() => undefined);
    });
  }, [offer]);

  // New capture while the projector is open: send it again.
  useEffect(() => {
    if (open && stream) void offer();
    if (!open) {
      pc.current?.close();
      pc.current = null;
    }
  }, [open, stream, offer]);

  const openProjector = useCallback(() => void window.studio.projector.open(chosen?.id ?? null), [chosen?.id]);

  // Start of a live: open by itself on an external screen; end of the live: close.
  const wasOnAir = useRef(false);
  useEffect(() => {
    if (onAir && !wasOnAir.current && prefs.projectorAuto && displays.some((d) => d.external)) openProjector();
    if (!onAir && wasOnAir.current) void window.studio.projector.close();
    wasOnAir.current = onAir;
  }, [onAir, prefs.projectorAuto, displays, openProjector]);

  const label = (d: ProjectorDisplay) =>
    `${fill(fr.projector.screenName, { n: d.index, w: d.width, h: d.height })} — ${d.external ? fr.projector.external : fr.projector.primary}`;

  return (
    <Card className="grid gap-3">
      <Kicker>{fr.projector.title}</Kicker>
      <p className="m-0 text-[0.85rem] text-muted">{fr.projector.help}</p>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[0.9rem]">
          {fr.projector.screen}
          <select
            className="rounded-md border border-line bg-white px-2 py-1.5"
            value={chosen?.id ?? ""}
            onFocus={() => void window.studio.projector.displays().then(setDisplays)}
            onChange={(e) => setPrefs({ ...prefs, projectorDisplay: Number(e.target.value) })}
          >
            {displays.map((d) => (
              <option key={d.id} value={d.id}>
                {label(d)}
              </option>
            ))}
          </select>
        </label>
        {open ? (
          <Btn variante="light" onClick={() => void window.studio.projector.close()}>
            {fr.projector.close}
          </Btn>
        ) : (
          <Btn variante="light" onClick={openProjector}>
            {fr.projector.open}
          </Btn>
        )}
      </div>
      <label className="flex items-center gap-2 text-[0.9rem]">
        <input type="checkbox" checked={prefs.projectorAuto} onChange={(e) => setPrefs({ ...prefs, projectorAuto: e.target.checked })} />
        {fr.projector.auto}
      </label>
    </Card>
  );
}
