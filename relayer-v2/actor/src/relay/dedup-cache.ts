// ABOUTME: Chain-scoped duplicate-calldata cache ported from v1 wallet-manager.ts: key =
// ABOUTME: chainId|keccak(to,data), 10-min TTL, stores the prior txHash (embedded in the 409 message).
import { keccak256, solidityPacked } from "ethers";

export const DEDUP_TTL_MS = 10 * 60 * 1000;

interface DedupEntry {
  txHash: string;
  timestamp: number;
}

export class DedupCache {
  private readonly entries = new Map<string, DedupEntry>();

  constructor(
    private readonly ttlMs: number = DEDUP_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  private key(chainId: number, to: string, data: string): string {
    return `${chainId}|${keccak256(solidityPacked(["address", "bytes"], [to, data]))}`;
  }

  /** Returns the prior txHash when the same (to, data) was broadcast within the TTL. */
  lookup(chainId: number, to: string, data: string): string | null {
    const entry = this.entries.get(this.key(chainId, to, data));
    if (!entry) return null;
    if (this.now() - entry.timestamp > this.ttlMs) {
      this.entries.delete(this.key(chainId, to, data));
      return null;
    }
    return entry.txHash;
  }

  /** Recorded after successful broadcast (v1 behavior — failures may be retried). */
  record(chainId: number, to: string, data: string, txHash: string): void {
    this.entries.set(this.key(chainId, to, data), { txHash, timestamp: this.now() });
  }

  /** Periodic sweep (v1 cleanDedupCache, every 5 min). */
  sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.timestamp < cutoff) this.entries.delete(key);
    }
  }
}
