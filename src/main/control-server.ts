import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ControlHttpHandler } from "./control-http";

const MAX_BODY_BYTES = 2048;

/** HTTP server of the local control API: bound to 127.0.0.1 only, never to another interface. */
export class ControlServer {
  private server: Server | null = null;

  constructor(private readonly handler: (port: () => number) => ControlHttpHandler) {}

  get listening(): boolean {
    return this.server?.listening === true;
  }

  get port(): number | null {
    const a = this.server?.address();
    return a && typeof a === "object" ? (a as AddressInfo).port : null;
  }

  /** Starts on `port` (0: any free one). Rejects with the system error (`EADDRINUSE`...). */
  start(port: number): Promise<number> {
    if (this.server) return Promise.reject(new Error("already started"));
    const handler = this.handler(() => this.port ?? port);
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let tooBig = false;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) tooBig = true;
        else chunks.push(c);
      });
      req.on("end", () => {
        const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
          const text = JSON.stringify(body);
          // No CORS header, ever: a web page cannot read an answer, and the preflight of a non-simple request fails.
          res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text), "Cache-Control": "no-store", Connection: "close", ...headers });
          res.end(text);
        };
        if (tooBig) return send(413, { ok: false, code: "too_large", message: "Body too large." });
        handler
          .handle({ method: req.method ?? "GET", url: req.url ?? "/", headers: req.headers, remoteAddress: req.socket.remoteAddress, body: Buffer.concat(chunks).toString("utf8") })
          .then((r) => send(r.status, r.body, r.headers))
          .catch(() => send(500, { ok: false, code: "failed", message: "Internal error." }));
      });
      req.on("error", () => res.destroy());
    });
    server.requestTimeout = 5000;
    server.headersTimeout = 5000;
    server.keepAliveTimeout = 1000;
    return new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      // 127.0.0.1 explicitly: never "localhost" (may resolve to another interface) and never all interfaces.
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        this.server = server;
        resolve((server.address() as AddressInfo).port);
      });
    });
  }

  stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return Promise.resolve();
    return new Promise((resolve) => {
      s.close(() => resolve());
      s.closeAllConnections();
    });
  }
}
