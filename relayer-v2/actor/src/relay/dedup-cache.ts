// ABOUTME: Chain-scoped duplicate-calldata cache (§6.2 step 8): identical calldata within
// ABOUTME: 10 minutes on the same chain is rejected as DUPLICATE_TX. In-memory only (P4).
import { keccak256, toUtf8Bytes } from "ethers";

export class DedupCache {
  private readonly entries = new Map<string, number>(); // key -> recordedAt ms

  constructor(
    private readonly ttlMs: number = 600_000,
    private readonly now: () => number = Date.now,
  ) {}

  private key(chainId: number, data: string): string {
    return keccak256(toUtf8Bytes(`${chainId}:${data.toLowerCase()}`));
  }

  has(chainId: number, data: string): boolean {
    const key = this.key(chainId, data);
    const at = this.entries.get(key);
    if (at === undefined) return false;
    if (this.now() - at > this.ttlMs) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  record(chainId: number, data: string): void {
    // Opportunistic sweep keeps the map bounded without a timer.
    if (this.entries.size > 10_000) {
      const cutoff = this.now() - this.ttlMs;
      for (const [k, at] of this.entries) if (at < cutoff) this.entries.delete(k);
    }
    this.entries.set(this.key(chainId, data), this.now());
  }
}
