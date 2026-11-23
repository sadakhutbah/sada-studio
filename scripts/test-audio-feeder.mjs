// Sound-card stand-in for manual / integration tests: serves 48 kHz mono s16le on a TCP port, paced on the wall
// clock, with a 50 ms 1 kHz beep at every wall-clock multiple of `period` ms. ffmpeg reads it as
// `-f s16le -ar 48000 -ac 1 -i tcp://127.0.0.1:PORT` (audio backend "pcm").
//   node scripts/test-audio-feeder.mjs [port=18999] [period=2000] [offset=0]
// `offset` (ms) moves the beep within the period: it lets a test give the sound a known lead over the picture.
import { createServer } from "node:net";

const RATE = 48000;

/** @param {number} port @param {number} periodMs */
export function startAudioFeeder(port = 18999, periodMs = 2000, offsetMs = 0) {
  const server = createServer((sock) => {
    let sent = 0;
    const t0 = Date.now();
    const timer = setInterval(() => {
      const target = Math.floor(((Date.now() - t0) / 1000) * RATE);
      const n = target - sent;
      if (n <= 0) return;
      const buf = Buffer.alloc(n * 2);
      for (let i = 0; i < n; i++) {
        const wallMs = t0 + ((sent + i) / RATE) * 1000;
        const beep = (((wallMs - offsetMs) % periodMs) + periodMs) % periodMs < 50;
        buf.writeInt16LE(beep ? Math.round(24000 * Math.sin((2 * Math.PI * 1000 * (sent + i)) / RATE)) : 0, i * 2);
      }
      sent = target;
      sock.write(buf);
    }, 10);
    const stop = () => clearInterval(timer);
    sock.on("error", stop);
    sock.on("close", stop);
  });
  server.listen(port, "127.0.0.1");
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startAudioFeeder(Number(process.argv[2] ?? 18999), Number(process.argv[3] ?? 2000), Number(process.argv[4] ?? 0));
}
