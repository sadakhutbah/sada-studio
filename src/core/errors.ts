import { t } from "./messages";

/** Kind of fatal broadcast error: `conflict` = another live is running; `capture` = camera or microphone. */
export type ErrorCode = "conflict" | "capture";

/** Error after which retrying right away is pointless (permissions, camera lost, live already running…). */
export class FatalError extends Error {
  /** `conflict`: another live occupies the mosque; we will retry later, without insisting. */
  readonly code?: ErrorCode;
  constructor(message: string, code?: ErrorCode) {
    super(message);
    this.name = "FatalError";
    this.code = code;
  }
}

/** Unexpected HTTP response from Sada; `status` 0 = server unreachable. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** The server no longer recognizes this device (deleted or revoked in the console). */
export class DeviceRevokedError extends ApiError {
  constructor(message = t("error.deviceRemoved")) {
    super(401, message);
    this.name = "DeviceRevokedError";
  }
}
