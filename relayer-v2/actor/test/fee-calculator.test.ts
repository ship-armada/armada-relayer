// ABOUTME: Golden tests for the fee formula and schedule lifecycle (§6.1): constants, floor,
// ABOUTME: cacheId format, TTL expiry, one-deep previous retention with variance buffer.
import { describe, it, expect } from "vitest";
import {
  FeeCalculator,
  GAS_ESTIMATES,
  computeFeeUsdcRaw,
  grossUpForShieldFee,
  advertisedFee,
  FEE_FLOOR_USDC_RAW,
  type FeeSchedule,
} from "../src/relay/fee-calculator.js";

const GWEI = 1_000_000_000n;

describe("computeFeeUsdcRaw (§6.1 formula)", () => {
  it("golden: 500k gas × 10 gwei × $3000 × 10% margin", () => {
    // 500000 × 10e9 wei = 5e15 wei = 0.005 ETH; × 3000 = $15; × 1.1 = $16.5 => 16_500_000 raw
    expect(computeFeeUsdcRaw(500_000, 10n * GWEI, 3000, 1000)).toBe(16_500_000n);
  });

  it("golden: 2M gas (crossContract) × 50 gwei × $2500 × 0% margin", () => {
    // 2e6 × 5e10 = 1e17 wei = 0.1 ETH × 2500 = $250 => 250_000_000 raw
    expect(computeFeeUsdcRaw(2_000_000, 50n * GWEI, 2500, 0)).toBe(250_000_000n);
  });

  it("floors at 10,000 raw units (0.01 USDC)", () => {
    expect(computeFeeUsdcRaw(300_000, 1n, 0.01, 0)).toBe(FEE_FLOOR_USDC_RAW);
  });

  it("gas estimates preserved from v1 (§6.1)", () => {
    expect(GAS_ESTIMATES).toEqual({
      transfer: 500_000,
      unshield: 500_000,
      crossChainShield: 500_000,
      crossChainUnshield: 500_000,
      crossContract: 2_000_000,
      shield: 300_000,
      shieldXchain: 400_000,
    });
  });
});

function makeCalculator(nowRef: { t: number }) {
  return new FeeCalculator(
    { gasPriceWei: async () => 10n * GWEI },
    { current: () => ({ price: 3000 }), refresh: async () => ({}) },
    {
      feeTtlSeconds: 300,
      feeVarianceBufferBps: 2000,
      profitMarginBps: 1000,
      shieldFeeBps: 0, // neutral: gross-up is a no-op; exercised separately below
      broadcasterRailgunAddress: "0zk1test",
      now: () => nowRef.t,
    },
  );
}

describe("FeeCalculator schedule lifecycle", () => {
  it("produces the FeeSchedule shape with cacheId format fee-{chainId}-{ts}-{counter}", async () => {
    const now = { t: 1_750_000_000_000 };
    const calc = makeCalculator(now);
    const schedule = await calc.getSchedule(31337);
    expect(schedule.cacheId).toBe(`fee-31337-${now.t}-1`);
    expect(schedule.chainId).toBe(31337);
    expect(schedule.expiresAt).toBe(now.t + 300_000);
    expect(schedule.broadcasterRailgunAddress).toBe("0zk1test");
    expect(Object.keys(schedule.fees).sort()).toEqual(
      ["crossChainShield", "crossChainUnshield", "crossContract", "shield", "shieldXchain", "transfer", "unshield"],
    );
    // all values are strings of raw USDC units
    for (const v of Object.values(schedule.fees)) expect(v).toMatch(/^\d+$/);
  });

  it("returns the cached schedule until expiry, then regenerates with a new counter", async () => {
    const now = { t: 1_750_000_000_000 };
    const calc = makeCalculator(now);
    const first = await calc.getSchedule(31337);
    now.t += 100_000;
    expect((await calc.getSchedule(31337)).cacheId).toBe(first.cacheId);
    now.t += 300_000;
    const regenerated = await calc.getSchedule(31337);
    expect(regenerated.cacheId).toBe(`fee-31337-${now.t}-2`);
  });

  it("resolve honors current, previous-within-buffer, and rejects beyond buffer", async () => {
    const now = { t: 1_750_000_000_000 };
    const calc = makeCalculator(now);
    const first = await calc.getSchedule(31337);
    now.t += 301_000; // expire first
    const second = await calc.getSchedule(31337);

    expect(calc.resolve(31337, second.cacheId)).toEqual(second);
    // previous is retained: buffer = 300s × 2000bps / 10000 = 60s past its expiry
    expect(calc.resolve(31337, first.cacheId)).toEqual(first);
    now.t = first.expiresAt + 59_000;
    expect(calc.resolve(31337, first.cacheId)).toEqual(first);
    now.t = first.expiresAt + 61_000;
    expect(calc.resolve(31337, first.cacheId)).toBeNull();
  });

  it("cacheId cannot be replayed cross-chain", async () => {
    const now = { t: 1_750_000_000_000 };
    const calc = makeCalculator(now);
    const hub = await calc.getSchedule(31337);
    await calc.getSchedule(31338);
    expect(calc.resolve(31338, hub.cacheId)).toBeNull();
  });

  it("only one previous schedule is retained (one-deep)", async () => {
    const now = { t: 1_750_000_000_000 };
    const calc = makeCalculator(now);
    const first = await calc.getSchedule(31337);
    now.t += 301_000;
    await calc.getSchedule(31337);
    now.t += 301_000;
    await calc.getSchedule(31337);
    expect(calc.resolve(31337, first.cacheId)).toBeNull();
  });
});

describe("advertisedFee", () => {
  it("takes the min across the quoted keys (transact = min(transfer, unshield))", () => {
    const schedule = {
      fees: { transfer: "500", unshield: "300" },
    } as unknown as FeeSchedule;
    expect(advertisedFee(schedule, ["transfer", "unshield"])).toBe(300n);
  });
});

describe("grossUpForShieldFee (shield-tier gross-up for the on-chain shield fee)", () => {
  it("is a no-op at 0 bps and on a zero fee", () => {
    expect(grossUpForShieldFee(1000n, 0)).toBe(1000n);
    expect(grossUpForShieldFee(0n, 50)).toBe(0n);
  });

  it("ceil-grosses so the relayer nets >= target after the (floored) shield fee", () => {
    const gross = grossUpForShieldFee(1000n, 50);
    expect(gross).toBeGreaterThan(1000n);
    const net = gross - (gross * 50n) / 10_000n; // on-chain shield fee is floored
    expect(net).toBeGreaterThanOrEqual(1000n);
  });

  it("schedule grosses up shield/shieldXchain only, leaving Phase-A tiers verbatim", async () => {
    const now = { t: 1_750_000_000_000 };
    const calc = new FeeCalculator(
      { gasPriceWei: async () => 10n * GWEI },
      { current: () => ({ price: 3000 }), refresh: async () => ({}) },
      {
        feeTtlSeconds: 300,
        feeVarianceBufferBps: 2000,
        profitMarginBps: 0,
        shieldFeeBps: 50,
        broadcasterRailgunAddress: "0zk1test",
        now: () => now.t,
      },
    );
    const s = await calc.getSchedule(31337);
    const raw = (k: keyof FeeSchedule["fees"]) => computeFeeUsdcRaw(GAS_ESTIMATES[k], 10n * GWEI, 3000, 0);
    // Phase-A tiers are SNARK broadcaster outputs (no shield fee) → verbatim.
    expect(BigInt(s.fees.transfer)).toBe(raw("transfer"));
    expect(BigInt(s.fees.crossChainUnshield)).toBe(raw("crossChainUnshield"));
    // Gasless shield tiers are shielded fee notes → grossed up.
    expect(BigInt(s.fees.shield)).toBe(grossUpForShieldFee(raw("shield"), 50));
    expect(BigInt(s.fees.shieldXchain)).toBe(grossUpForShieldFee(raw("shieldXchain"), 50));
    expect(BigInt(s.fees.shield)).toBeGreaterThan(raw("shield"));
  });
});
