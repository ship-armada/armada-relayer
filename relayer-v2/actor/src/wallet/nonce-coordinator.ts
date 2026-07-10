// ABOUTME: Per-chain nonce streams serialized so concurrent submissions never collide (§6.5):
// ABOUTME: seeded from getTransactionCount(pending), advanced only on successful broadcast.

export type NonceSeeder = (chainId: number) => Promise<number>;

interface ChainStream {
  next: number | null; // null => needs (re)seed
  queue: Promise<unknown>;
}

export class NonceCoordinator {
  private readonly streams = new Map<number, ChainStream>();

  constructor(private readonly seed: NonceSeeder) {}

  private stream(chainId: number): ChainStream {
    let s = this.streams.get(chainId);
    if (!s) {
      s = { next: null, queue: Promise.resolve() };
      this.streams.set(chainId, s);
    }
    return s;
  }

  /**
   * Runs fn with the chain's next nonce, serialized against all other submissions on that
   * chain. The nonce advances only if fn resolves (successful broadcast); a rejection
   * leaves the stream where it was so the nonce is reused.
   */
  async withNonce<T>(chainId: number, fn: (nonce: number) => Promise<T>): Promise<T> {
    const s = this.stream(chainId);
    const run = s.queue.then(
      async () => {
        if (s.next === null) s.next = await this.seed(chainId);
        const nonce = s.next;
        const result = await fn(nonce);
        s.next = nonce + 1;
        return result;
      },
      // keep serialization even if a predecessor rejected
    );
    s.queue = run.catch(() => {});
    return run;
  }

  /** Re-seeds the chain's stream on next use — called after stuck-tx recovery (§6.5, §8.4). */
  reset(chainId: number): void {
    const s = this.streams.get(chainId);
    if (s) s.next = null;
  }
}
