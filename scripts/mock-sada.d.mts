export interface MockRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}
export interface MockSada {
  url: string;
  requests: MockRequest[];
  schedule: Array<Record<string, unknown>>;
  manual: { type: string; title: string; startedAt: number; deviceId: string | null } | null;
  stopped: Set<string>;
  readonly command: "standby" | "live";
  readonly current: Record<string, unknown> | null;
  readonly devices: Array<{ id: string; secret: string; name: string; revoked: boolean }>;
  whipStatus: number | null;
  otherPublisher: boolean;
  now: () => number;
  failHeartbeats: number;
  heartbeatInterval: number;
  since: string;
  heartbeats(): Array<Record<string, any>>;
  approve(userCode?: string): void;
  revokeAll(): void;
  rotateAll(): void;
  setLive(o?: { type?: string; title?: string; source?: "manual" | "schedule" }): void;
  setIdle(): void;
  close(): Promise<void>;
}
export function createMockSada(o?: { port?: number; approveAfterMs?: number | null; codeTtlS?: number; log?: boolean }): Promise<MockSada>;
export function nextFriday(now?: number): number;
