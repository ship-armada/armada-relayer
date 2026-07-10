// ABOUTME: Health classification and response shape ported from v1 (types.ts RelayerHealth /
// ABOUTME: ChainHealth) — per-chain freshness from watcher progress, worst-wins rollup, counters.
import type { WatcherChainProgress } from "../db/types.js";

export type ChainHealthStatus = "healthy" | "degraded" | "stale" | "unhealthy";

/** v1 ChainHealth row (relayer/types.ts:144) — field names are the frontend contract (B2). */
export interface ChainHealthReport {
  chainName: string;
  domain: number;
  status: ChainHealthStatus;
  lastProcessedBlock: number;
  chainHead: number;
  lagBlocks: number;
  lastScanAt: number; // epoch ms; 0 when never scanned
  lastError: { message: string; at: number } | null;
  pendingCount: number;
  deadLetterCount: number;
}

export interface ChainHealthInput {
  chainName: string;
  domain: number;
  pollIntervalMs: number;
  nominalBlockTimeMs: number;
  progress: WatcherChainProgress | undefined;
  lastTickErrored?: boolean;
  pendingCount: number;
  deadLetterCount: number;
}

export function classifyChain(nowMs: number, input: ChainHealthInput): ChainHealthReport {
  const { progress } = input;
  const lastScanMs = progress?.lastIndexedBlockTimestamp?.getTime() ?? null;
  const ageMs = lastScanMs === null ? null : nowMs - lastScanMs;
  const lastProcessedBlock = progress === undefined ? 0 : Number(progress.lastIndexedBlock);
  // The actor holds no chain head (D1 keeps its RPC minimal) — head and lag are estimated
  // from the indexing-timestamp age and the chain's nominal block time.
  const lagBlocks =
    ageMs === null ? 0 : Math.max(0, Math.floor(ageMs / input.nominalBlockTimeMs) - 1);
  const chainHead = lastProcessedBlock + lagBlocks;

  let status: ChainHealthStatus;
  if (progress === undefined || ageMs === null || ageMs > 10 * input.pollIntervalMs) {
    status = "unhealthy"; // never scanned, or > 10× poll interval
  } else if (ageMs > 3 * input.pollIntervalMs) {
    status = "stale";
  } else if (input.lastTickErrored || lagBlocks > 100) {
    status = "degraded";
  } else {
    status = "healthy";
  }
  return {
    chainName: input.chainName,
    domain: input.domain,
    status,
    lastProcessedBlock,
    chainHead,
    lagBlocks,
    lastScanAt: lastScanMs ?? 0,
    lastError: null,
    pendingCount: input.pendingCount,
    deadLetterCount: input.deadLetterCount,
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

/** v1: 200 for healthy|degraded, 503 otherwise. */
export function healthHttpStatus(status: ChainHealthStatus): number {
  return status === "healthy" || status === "degraded" ? 200 : 503;
}

/**
 * In-process counters with v1's dotted-key scheme (relayer/modules/counters.ts):
 * submitSuccess.<selector>, submitFail.<selector>.<CODE>, feeVerifierRejects.<CODE>,
 * rateLimited, idempotentReplay, messageFilterReject, revertedTx.<chainId>, stuckTx.<chainId>.
 * Reset on restart (v1 behavior); Prometheus is the durable view (§16.3).
 */
export class Counters {
  private readonly map = new Map<string, number>();

  inc(key: string, by = 1): void {
    this.map.set(key, (this.map.get(key) ?? 0) + by);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.map);
  }
}
