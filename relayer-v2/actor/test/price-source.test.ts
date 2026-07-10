// ABOUTME: Price-source guard tests (§8.8): staleness rejection, sanity clamp, last-known-good
// ABOUTME: fallback, static emergency floor, decimals normalization, degraded flag transitions.
import { describe, it, expect } from "vitest";
import {
  ChainlinkPriceSource,
  StaticPriceSource,
  type AggregatorReader,
} from "../src/relay/price-source.js";

function makeReader(answers: { answer: bigint; updatedAt: bigint }[], decimals = 8) {
  let i = 0;
  const reader: AggregatorReader = {
    decimals: async () => decimals,
    latestRoundData: async () => {
      const a = answers[Math.min(i, answers.length - 1)]!;
      i += 1;
      return a;
    },
  };
  return reader;
}

const NOW = 1_750_000_000_000;
const FRESH = BigInt(Math.floor(NOW / 1000) - 60); // updated 60s ago

function opts(overrides: Record<string, unknown> = {}) {
  return {
    maxStalenessMs: 5_400_000,
    min: 100,
    max: 100_000,
    staticFallback: 2222,
    now: () => NOW,
    ...overrides,
  };
}

describe("ChainlinkPriceSource (§8.8)", () => {
  it("accepts a fresh in-range reading, normalizing by feed decimals", async () => {
    const source = new ChainlinkPriceSource(
      makeReader([{ answer: 3000_00000000n, updatedAt: FRESH }]),
      opts(),
    );
    expect(await source.refresh()).toEqual({ price: 3000, degraded: false });
  });

  it("normalizes non-8-decimal feeds (no hardcoded assumption)", async () => {
    const source = new ChainlinkPriceSource(
      makeReader([{ answer: 3000_000000000000000000n, updatedAt: FRESH }], 18),
      opts(),
    );
    expect((await source.refresh()).price).toBe(3000);
  });

  it("rejects stale readings and holds last-known-good, degraded", async () => {
    const stale = BigInt(Math.floor(NOW / 1000) - 6000); // 100 min old > 1.5h? no: 6000s=100min > 90min ✓
    const source = new ChainlinkPriceSource(
      makeReader([
        { answer: 3000_00000000n, updatedAt: FRESH },
        { answer: 9999_00000000n, updatedAt: stale },
      ]),
      opts(),
    );
    await source.refresh();
    expect(await source.refresh()).toEqual({ price: 3000, degraded: true });
  });

  it("rejects out-of-clamp readings (both sides)", async () => {
    const source = new ChainlinkPriceSource(
      makeReader([
        { answer: 3000_00000000n, updatedAt: FRESH },
        { answer: 50_00000000n, updatedAt: FRESH }, // below min 100
      ]),
      opts(),
    );
    await source.refresh();
    expect(await source.refresh()).toEqual({ price: 3000, degraded: true });

    const high = new ChainlinkPriceSource(
      makeReader([{ answer: 200_000_00000000n, updatedAt: FRESH }]),
      opts(),
    );
    expect(await high.refresh()).toEqual({ price: 2222, degraded: true });
  });

  it("falls back to the static price when no reading has ever been accepted", async () => {
    const source = new ChainlinkPriceSource(
      makeReader([{ answer: 0n, updatedAt: 0n }]),
      opts(),
    );
    expect(await source.refresh()).toEqual({ price: 2222, degraded: true });
  });

  it("recovers from degraded when a good reading arrives", async () => {
    const source = new ChainlinkPriceSource(
      makeReader([
        { answer: 1n, updatedAt: 0n }, // rejected
        { answer: 3100_00000000n, updatedAt: FRESH },
      ]),
      opts(),
    );
    await source.refresh();
    expect(await source.refresh()).toEqual({ price: 3100, degraded: false });
  });

  it("reports gauge updates via onReading", async () => {
    const readings: { price: number; degraded: boolean }[] = [];
    const source = new ChainlinkPriceSource(
      makeReader([{ answer: 3000_00000000n, updatedAt: FRESH }]),
      opts({ onReading: (r: { price: number; degraded: boolean }) => readings.push(r) }),
    );
    await source.refresh();
    expect(readings).toEqual([{ price: 3000, degraded: false }]);
  });

  it("quotes are never refused: current() always returns a price", () => {
    const source = new ChainlinkPriceSource(makeReader([]), opts());
    expect(source.current()).toEqual({ price: 2222, degraded: true });
  });
});

describe("StaticPriceSource (local mode)", () => {
  it("returns the static value, never degraded", async () => {
    const source = new StaticPriceSource(3333);
    expect(await source.refresh()).toEqual({ price: 3333, degraded: false });
  });
});
