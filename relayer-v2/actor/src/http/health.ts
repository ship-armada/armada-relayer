// ABOUTME: Health classification preserving v1 semantics (§6.6): per-chain freshness from the
// ABOUTME: watcher's indexing progress in Postgres, worst-wins rollup, 503 on stale/unhealthy.
import type { WatcherChainProgress } from "../db/types.js";

export type ChainHealthStatus = "healthy" | "degraded" | "stale" | "unhealthy";

export interface ChainHealthReport {
  chainId: number;
  status: ChainHealthStatus;
  lastScanAt: string | null; // ISO; watcher's last indexed block timestamp
  lagBlocks: number | null;
  lastIndexedBlock: string | null;
}

export interface ChainHealthInput {
  chainId: number;
  pollIntervalMs: number;
  nominalBlockTimeMs: number;
  progress: WatcherChainProgress | undefined;
  lastTickErrored?: boolean;
}

export function classifyChain(nowMs: number, input: ChainHealthInput): ChainHealthReport {
  const { progress } = input;
  const lastScanMs = progress?.lastIndexedBlockTimestamp?.getTime() ?? null;
  const ageMs = lastScanMs === null ? null : nowMs - lastScanMs;
  // Lag estimated from timestamp age (the actor holds no chain head; D1 keeps RPC minimal).
  const lagBlocks =
    ageMs === null ? null : Math.max(0, Math.floor(ageMs / input.nominalBlockTimeMs) - 1);

  let status: ChainHealthStatus;
  if (progress === undefined || ageMs === null || ageMs > 10 * input.pollIntervalMs) {
    status = "unhealthy"; // never scanned, or > 10× poll interval
  } else if (ageMs > 3 * input.pollIntervalMs) {
    status = "stale";
  } else if (input.lastTickErrored || (lagBlocks !== null && lagBlocks > 100)) {
    status = "degraded";
  } else {
    status = "healthy";
  }
  return {
    chainId: input.chainId,
    status,
    lastScanAt: lastScanMs === null ? null : new Date(lastScanMs).toISOString(),
    lagBlocks,
    lastIndexedBlock: progress ? progress.lastIndexedBlock.toString() : null,
  };
}

const SEVERITY: Record<ChainHealthStatus, number> = {
  healthy: 0,
  degraded: 1,
  stale: 2,
  unhealthy: 3,
};

export function rollup(chains: ChainHealthReport[]): ChainHealthStatus {
  let worst: ChainHealthStatus = "healthy";
  for (const chain of chains) {
    if (SEVERITY[chain.status] > SEVERITY[worst]) worst = chain.status;
  }
  return worst;
}

/** /health returns 503 only when the rollup is stale or unhealthy (§6.6). */
export function healthHttpStatus(status: ChainHealthStatus): number {
  return status === "stale" || status === "unhealthy" ? 503 : 200;
}

/** In-process counters kept for the v1-compatible /health `counters` field (§9.1, §16.3). */
export interface HealthCounters {
  submitSuccess: number;
  submitFail: number;
  feeVerifierRejects: number;
  rateLimited: number;
  idempotentReplay: number;
}

export function newCounters(): HealthCounters {
  return {
    submitSuccess: 0,
    submitFail: 0,
    feeVerifierRejects: 0,
    rateLimited: 0,
    idempotentReplay: 0,
  };
}
