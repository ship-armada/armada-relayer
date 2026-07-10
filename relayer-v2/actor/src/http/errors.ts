// ABOUTME: Relay error codes and their HTTP status map, preserved verbatim from v1 (§6.2):
// ABOUTME: 402 for fee errors, 409 duplicate, 429 rate limit, 502 broadcast, 503 busy.

export type RelayErrorCode =
  | "INVALID_CHAIN"
  | "INVALID_TARGET"
  | "INVALID_DATA"
  | "FEE_TOO_LOW"
  | "FEE_EXPIRED"
  | "FEE_INSUFFICIENT"
  | "GAS_ESTIMATION_FAILED"
  | "DUPLICATE_TX"
  | "RELAYER_BUSY"
  | "SUBMISSION_FAILED"
  | "RATE_LIMITED";

export const HTTP_STATUS_OF: Record<RelayErrorCode, number> = {
  INVALID_CHAIN: 400,
  INVALID_TARGET: 400,
  INVALID_DATA: 400,
  FEE_TOO_LOW: 402,
  FEE_EXPIRED: 402,
  FEE_INSUFFICIENT: 402,
  GAS_ESTIMATION_FAILED: 422,
  DUPLICATE_TX: 409,
  RELAYER_BUSY: 503,
  SUBMISSION_FAILED: 502,
  RATE_LIMITED: 429,
};

export class RelayError extends Error {
  constructor(
    readonly code: RelayErrorCode,
    message?: string,
  ) {
    super(message ?? code);
  }

  get status(): number {
    return HTTP_STATUS_OF[this.code];
  }
}
