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
  command: "idle" | "live";
  current: Record<string, unknown> | null;
  whipStatus: number | null;
  failHeartbeats: number;
  heartbeatInterval: number;
  since: string;
  heartbeats(): Array<Record<string, any>>;
  approve(userCode?: string): void;
  revokeAll(): void;
  setLive(current: Record<string, unknown>): void;
  setIdle(): void;
  close(): Promise<void>;
}
export function createMockSada(o?: { port?: number; approveAfterMs?: number | null; codeTtlS?: number; log?: boolean }): Promise<MockSada>;
export function nextFriday(now?: number): number;
