// ABOUTME: Pure helpers for the read API (§7.3): param parsing, limit clamping, block-based
// ABOUTME: cursors, and the Cache-Control rule that makes CDN fronting a config change.

export const MAX_LIMIT = 1000;

export interface RangeParams {
  fromBlock: bigint;
  toBlock: bigint | null;
  limit: number;
}

export function parseRangeParams(query: {
  fromBlock?: string;
  toBlock?: string;
  limit?: string;
}): RangeParams | { error: string } {
  if (query.fromBlock === undefined || !/^\d+$/.test(query.fromBlock)) {
    return { error: "fromBlock is required and must be a non-negative integer" };
  }
  if (query.toBlock !== undefined && !/^\d+$/.test(query.toBlock)) {
    return { error: "toBlock must be a non-negative integer" };
  }
  let limit = MAX_LIMIT;
  if (query.limit !== undefined) {
    if (!/^\d+$/.test(query.limit) || Number(query.limit) < 1) {
      return { error: "limit must be a positive integer" };
    }
    limit = Math.min(Number(query.limit), MAX_LIMIT);
  }
  return {
    fromBlock: BigInt(query.fromBlock),
    toBlock: query.toBlock === undefined ? null : BigInt(query.toBlock),
    limit,
  };
}

/** Block-based nextCursor: next block to request when the page filled, else null. */
export function nextCursorOf(items: { blockNumber: bigint | string }[], limit: number): string | null {
  if (items.length < limit) return null;
  const last = items[items.length - 1]!;
  return (BigInt(last.blockNumber) + 1n).toString();
}

/**
 * Cache-Control (§7.3): historical closed ranges (toBlock <= indexedThrough - confirmations)
 * are immutable for a day; open-ended/near-head responses cache for 5 seconds.
 */
export function cacheControlFor(
  toBlock: bigint | null,
  indexedThrough: bigint | null,
  confirmations: number,
): string {
  if (
    toBlock !== null &&
    indexedThrough !== null &&
    toBlock <= indexedThrough - BigInt(confirmations)
  ) {
    return "public, max-age=86400, immutable";
  }
  return "public, max-age=5";
}

/** Ponder checkpoint decoding (fixed-width string; verified against pinned 0.16.8). */
export function checkpointBlock(checkpoint: string): { number: bigint; timestamp: bigint } | null {
  if (!/^\d{75}$/.test(checkpoint)) return null;
  return {
    timestamp: BigInt(checkpoint.slice(0, 10)),
    number: BigInt(checkpoint.slice(26, 42)),
  };
}

export type WatcherHealthStatus = "healthy" | "degraded" | "stale" | "unhealthy";

/** §6.6 freshness classification applied to watcher chains (used by /v1/health). */
export function classifyFreshness(
  nowMs: number,
  lastIndexedAtMs: number | null,
  pollIntervalMs: number,
  lagBlocks: number | null,
): WatcherHealthStatus {
  if (lastIndexedAtMs === null || nowMs - lastIndexedAtMs > 10 * pollIntervalMs) {
    return "unhealthy";
  }
  if (nowMs - lastIndexedAtMs > 3 * pollIntervalMs) return "stale";
  if (lagBlocks !== null && lagBlocks > 100) return "degraded";
  return "healthy";
}

export function worstOf(statuses: WatcherHealthStatus[]): WatcherHealthStatus {
  const order: WatcherHealthStatus[] = ["healthy", "degraded", "stale", "unhealthy"];
  return statuses.reduce(
    (worst, s) => (order.indexOf(s) > order.indexOf(worst) ? s : worst),
    "healthy" as WatcherHealthStatus,
  );
}
