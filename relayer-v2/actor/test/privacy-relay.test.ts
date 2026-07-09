// ABOUTME: Pipeline tests for POST /relay (§6.2): every error code reproducible in order,
// ABOUTME: gasless + broadcaster fee paths, dedup window, gas buffer, lock release.
import { describe, it, expect } from "vitest";
import { FeeCalculator } from "../src/relay/fee-calculator.js";
import { PrivacyRelay, type RelaySubmitter } from "../src/relay/privacy-relay.js";
import { DedupCache } from "../src/relay/dedup-cache.js";
import { RelayError } from "../src/http/errors.js";
import {
  SELECTOR_TRANSACT,
  SELECTOR_GASLESS_SHIELD,
} from "../src/relay/selectors.js";
import { Interface, parseUnits } from "ethers";

const POOL = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const WRAPPER = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
const GWEI = 1_000_000_000n;

const GASLESS_IFACE = new Interface([
  "function gaslessShield(bytes shieldRequest, address token, uint256 fee, bytes permit)",
]);

function gaslessCalldata(fee: bigint): string {
  return GASLESS_IFACE.encodeFunctionData("gaslessShield", ["0x1234", POOL, fee, "0x"]);
}

function transactCalldata(): string {
  return SELECTOR_TRANSACT + "ab".repeat(64);
}

interface Harness {
  relay: PrivacyRelay;
  calc: FeeCalculator;
  now: { t: number };
  submitted: { chainId: number; gasLimit: bigint }[];
  extractorAmount: { value: bigint | null }; // null => extractor throws
  busy: Set<number>;
  estimateFails: { value: boolean };
  submitFails: { value: boolean };
}

function makeHarness(): Harness {
  const now = { t: 1_750_000_000_000 };
  const calc = new FeeCalculator(
    { gasPriceWei: async () => 10n * GWEI },
    { current: () => ({ price: 3000 }), refresh: async () => ({}) },
    {
      feeTtlSeconds: 300,
      feeVarianceBufferBps: 2000,
      profitMarginBps: 0,
      broadcasterRailgunAddress: "0zk1test",
      now: () => now.t,
    },
  );
  const submitted: Harness["submitted"] = [];
  const extractorAmount = { value: parseUnits("1000", 6) as bigint | null };
  const busy = new Set<number>();
  const estimateFails = { value: false };
  const submitFails = { value: false };
  const submitter: RelaySubmitter = {
    tryAcquire: (chainId) => {
      if (busy.has(chainId)) return false;
      busy.add(chainId);
      return true;
    },
    release: (chainId) => busy.delete(chainId),
    estimateGas: async () => {
      if (estimateFails.value) throw new Error("execution reverted");
      return 100_000n;
    },
    submit: async (chainId, tx) => {
      if (submitFails.value) throw new Error("nonce too low");
      submitted.push({ chainId, gasLimit: tx.gasLimit });
      return { hash: "0x" + "cc".repeat(32) };
    },
  };
  const relay = new PrivacyRelay({
    targets: new Map([
      [
        31337,
        {
          chainId: 31337,
          allowlist: new Set([POOL.toLowerCase(), WRAPPER.toLowerCase()]),
          wrapperAddress: WRAPPER,
        },
      ],
    ]),
    feeCalculator: calc,
    extractor: {
      extractFeeNoteUsdcAmount: async () => {
        if (extractorAmount.value === null) throw new Error("cannot decrypt");
        return extractorAmount.value;
      },
    },
    submitter,
    dedup: new DedupCache(600_000, () => now.t),
  });
  return { relay, calc, now, submitted, extractorAmount, busy, estimateFails, submitFails };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (err: unknown) => err instanceof RelayError && err.code === code,
  );
}

describe("PrivacyRelay pipeline (§6.2, order preserved)", () => {
  it("1. unknown chain → INVALID_CHAIN", async () => {
    const h = makeHarness();
    await expectCode(
      h.relay.relay({ chainId: 999, to: POOL, data: transactCalldata(), feesCacheId: "x" }),
      "INVALID_CHAIN",
    );
  });

  it("2. target not in allowlist → INVALID_TARGET (case-insensitive accept)", async () => {
    const h = makeHarness();
    await expectCode(
      h.relay.relay({
        chainId: 31337,
        to: "0x" + "99".repeat(20),
        data: transactCalldata(),
        feesCacheId: "x",
      }),
      "INVALID_TARGET",
    );
    // case-insensitive: uppercase target passes the allowlist check (fails later on fee)
    const schedule = await h.calc.getSchedule(31337);
    const result = await h.relay.relay({
      chainId: 31337,
      to: POOL.toUpperCase().replace("0X", "0x"),
      data: transactCalldata(),
      feesCacheId: schedule.cacheId,
    });
    expect(result.status).toBe("pending");
  });

  it("3. unknown/expired feesCacheId → FEE_EXPIRED", async () => {
    const h = makeHarness();
    await expectCode(
      h.relay.relay({ chainId: 31337, to: POOL, data: transactCalldata(), feesCacheId: "nope" }),
      "FEE_EXPIRED",
    );
  });

  it("4. disallowed selector → INVALID_DATA", async () => {
    const h = makeHarness();
    const schedule = await h.calc.getSchedule(31337);
    await expectCode(
      h.relay.relay({
        chainId: 31337,
        to: POOL,
        data: "0xdeadbeef" + "00".repeat(32),
        feesCacheId: schedule.cacheId,
      }),
      "INVALID_DATA",
    );
  });

  it("5a. broadcaster path: decrypted fee below advertised → FEE_INSUFFICIENT", async () => {
    const h = makeHarness();
    h.extractorAmount.value = 1n;
    const schedule = await h.calc.getSchedule(31337);
    await expectCode(
      h.relay.relay({
        chainId: 31337,
        to: POOL,
        data: transactCalldata(),
        feesCacheId: schedule.cacheId,
      }),
      "FEE_INSUFFICIENT",
    );
  });

  it("5b. broadcaster path: extractor failure fails closed → FEE_INSUFFICIENT", async () => {
    const h = makeHarness();
    h.extractorAmount.value = null;
    const schedule = await h.calc.getSchedule(31337);
    await expectCode(
      h.relay.relay({
        chainId: 31337,
        to: POOL,
        data: transactCalldata(),
        feesCacheId: schedule.cacheId,
      }),
      "FEE_INSUFFICIENT",
    );
  });

  it("5c. gasless path: wrong target → INVALID_TARGET; low fee → FEE_INSUFFICIENT", async () => {
    const h = makeHarness();
    const schedule = await h.calc.getSchedule(31337);
    await expectCode(
      h.relay.relay({
        chainId: 31337,
        to: POOL, // gasless must target the wrapper
        data: gaslessCalldata(10n ** 9n),
        feesCacheId: schedule.cacheId,
      }),
      "INVALID_TARGET",
    );
    await expectCode(
      h.relay.relay({
        chainId: 31337,
        to: WRAPPER,
        data: gaslessCalldata(1n),
        feesCacheId: schedule.cacheId,
      }),
      "FEE_INSUFFICIENT",
    );
    const ok = await h.relay.relay({
      chainId: 31337,
      to: WRAPPER,
      data: gaslessCalldata(10n ** 9n),
      feesCacheId: schedule.cacheId,
    });
    expect(ok.status).toBe("pending");
  });

  it("6. busy wallet → RELAYER_BUSY", async () => {
    const h = makeHarness();
    const schedule = await h.calc.getSchedule(31337);
    h.busy.add(31337);
    await expectCode(
      h.relay.relay({
        chainId: 31337,
        to: POOL,
        data: transactCalldata(),
        feesCacheId: schedule.cacheId,
      }),
      "RELAYER_BUSY",
    );
  });

  it("7. gas estimation revert → GAS_ESTIMATION_FAILED (and releases the lock)", async () => {
    const h = makeHarness();
    const schedule = await h.calc.getSchedule(31337);
    h.estimateFails.value = true;
    await expectCode(
      h.relay.relay({
        chainId: 31337,
        to: POOL,
        data: transactCalldata(),
        feesCacheId: schedule.cacheId,
      }),
      "GAS_ESTIMATION_FAILED",
    );
    expect(h.busy.has(31337)).toBe(false);
  });

  it("8a. duplicate calldata within 10 min → DUPLICATE_TX; ok after window", async () => {
    const h = makeHarness();
    const schedule = await h.calc.getSchedule(31337);
    const req = {
      chainId: 31337,
      to: POOL,
      data: transactCalldata(),
      feesCacheId: schedule.cacheId,
    };
    await h.relay.relay(req);
    await expectCode(h.relay.relay(req), "DUPLICATE_TX");
    h.now.t += 600_001;
    const fresh = await h.calc.getSchedule(31337);
    await expect(h.relay.relay({ ...req, feesCacheId: fresh.cacheId })).resolves.toMatchObject({
      status: "pending",
    });
  });

  it("8b. submits with a 20% gas buffer; broadcast failure → SUBMISSION_FAILED", async () => {
    const h = makeHarness();
    const schedule = await h.calc.getSchedule(31337);
    await h.relay.relay({
      chainId: 31337,
      to: POOL,
      data: transactCalldata(),
      feesCacheId: schedule.cacheId,
    });
    expect(h.submitted[0]!.gasLimit).toBe(120_000n); // 100k estimate × 1.2
    h.submitFails.value = true;
    await expectCode(
      h.relay.relay({
        chainId: 31337,
        to: POOL,
        data: transactCalldata() + "ff",
        feesCacheId: schedule.cacheId,
      }),
      "SUBMISSION_FAILED",
    );
  });
});
