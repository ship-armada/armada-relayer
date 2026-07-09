// ABOUTME: Per-IP token buckets (§6.3): POST /relay 10/min, GETs 60/min, refill capacity/60
// ABOUTME: per second, 429 on exhaustion. In-memory only — never persisted (P4).
import type { Request, Response, NextFunction } from "express";

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly capacityPerMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** True when the caller may proceed; consumes one token. */
  allow(key: string): boolean {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacityPerMinute, lastRefillMs: now };
      this.buckets.set(key, bucket);
    }
    const elapsedSec = (now - bucket.lastRefillMs) / 1000;
    if (elapsedSec > 0) {
      bucket.tokens = Math.min(
        this.capacityPerMinute,
        bucket.tokens + elapsedSec * (this.capacityPerMinute / 60),
      );
      bucket.lastRefillMs = now;
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Bounded sweep so idle IPs don't accumulate (still in-memory only, P4). */
  sweep(): void {
    const cutoff = this.now() - 10 * 60 * 1000;
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastRefillMs < cutoff) this.buckets.delete(key);
    }
  }
}

/** Client key: socket address, or X-Forwarded-For's first hop only when trustProxy (§6.3).
 * Used solely for in-memory rate limiting; never logged or persisted (P4). */
export function clientKey(req: Request, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

export function rateLimitMiddleware(
  limiter: TokenBucketLimiter,
  endpoint: string,
  trustProxy: boolean,
  onLimited?: (endpoint: string) => void,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (limiter.allow(clientKey(req, trustProxy))) {
      next();
      return;
    }
    onLimited?.(endpoint);
    res.status(429).json({ error: { code: "RATE_LIMITED", message: "rate limit exceeded" } });
  };
}
