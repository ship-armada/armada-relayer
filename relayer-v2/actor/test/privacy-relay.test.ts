// ABOUTME: Pipeline tests for POST /relay (§6.2, v1 semantics): every error code in order,
// ABOUTME: gasless + broadcaster fee paths, wrapper→synthetic-transact normalization, dedup.
import { describe, it, expect } from "vitest";
import { Interface, parseUnits } from "ethers";
import { FeeCalculator } from "../src/relay/fee-calculator.js";
import { PrivacyRelay, type RelaySubmitter } from "../src/relay/privacy-relay.js";
import { DedupCache } from "../src/relay/dedup-cache.js";
import { RelayError } from "../src/http/errors.js";
import { SELECTOR_TRANSACT, SELECTOR_GASLESS_SHIELD, selectorOf } from "../src/relay/selectors.js";
import {
  normaliseRequestToVanillaTransact,
} from "../src/relay/broadcaster-fee-verifier.js";
import { TRANSACT_ABI, WRAPPER_ABIS } from "../src/relay/transact-shape.js";

const POOL = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const WRAPPER = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
const USDC = "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9";
const GWEI = 1_000_000_000n;

const GASLESS_IFACE = new Interface([
  "function gaslessShield(address user, uint256 totalAmount, uint256 fee, uint256 deadline, uint8 v, bytes32 r, bytes32 s, ((bytes32,(uint8,address,uint256),uint120),(bytes32[3],bytes32)) shieldRequest, address integrator)",
]);

function gaslessCalldata(fee: bigint): string {
  return GASLESS_IFACE.encodeFunctionData("gaslessShield", [
    "0x" + "11".repeat(20),
    1000n,
    fee,
    9999n,
    27,
    "0x" + "01".repeat(32),
    "0x" + "02".repeat(32),
    [
      ["0x" + "03".repeat(32), [0, USDC, 0n], 500n],
      [["0x" + "04".repeat(32), "0x" + "05".repeat(32), "0x" + "06".repeat(32)], "0x" + "07".repeat(32)],
    ],
    "0x" + "09".repeat(20),
  ]);
}

/** A minimal-but-valid Railgun Transaction struct for wrapper encoding tests. */
const TX_STRUCT = {
  proof: {
    a: { x: 1n, y: 2n },
    b: { x: [1n, 2n], y: [3n, 4n] },
    c: { x: 5n, y: 6n },
  },
  merkleRoot: "0x" + "aa".repeat(32),
  nullifiers: ["0x" + "bb".repeat(32)],
  commitments: ["0x" + "cc".repeat(32)],
  boundParams: {
    treeNumber: 0,
    minGasPrice: 0n,
    unshield: 0,
    chainID: 31337n,
    adaptContract: "0x" + "00".repeat(20),
    adaptParams: "0x" + "00".repeat(32),
    commitmentCiphertext: [
      {
        ciphertext: ["0x" + "01".repeat(32), "0x" + "02".repeat(32), "0x" + "03".repeat(32), "0x" + "04".repeat(32)],
        blindedSenderViewingKey: "0x" + "05".repeat(32),
        blindedReceiverViewingKey: "0x" + "06".repeat(32),
        annotationData: "0x",
        memo: "0x",
      },
    ],
  },
  unshieldPreimage: {
    npk: "0x" + "07".repeat(32),
    token: { tokenType: 0, tokenAddress: USDC, tokenSubID: 0n },
    value: 100n,
  },
};

function transactCalldata(): string {
  return new Interface([...TRANSACT_ABI]).encodeFunctionData("transact", [[TX_STRUCT]]);
}

interface Harness {
  relay: PrivacyRelay;
  calc: FeeCalculator;
  now: { t: number };
  submitted: { chainId: number; gasLimit: bigint }[];
  extractorMap: { value: Record<string, bigint> | null }; // null => extractor throws
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
  const extractorMap = {
    value: { [USDC.toLowerCase()]: parseUnits("1000", 6) } as Record<string, bigint> | null,
  };
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
    allowedTargets: new Map([
      [31337, new Set([POOL.toLowerCase(), WRAPPER.toLowerCase()])],
    ]),
    feeCalculator: calc,
    gaslessCtx: { wrappersByChain: new Map([[31337, WRAPPER]]) },
    broadcasterCtx: {
      extractor: {
        extractFirstNoteERC20AmountMap: async () => {
          if (extractorMap.value === null) throw new Error("cannot decrypt");
          return extractorMap.value;
        },
      },
      privacyPoolAddress: POOL,
      usdcAddress: USDC,
    },
    submitter,
    dedup: new DedupCache(600_000, () => now.t),
  });
  return { relay, calc, now, submitted, extractorMap, busy, estimateFails, submitFails };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (err: unknown) => err instanceof RelayError && err.code === code,
  );
}

describe("wrapper → synthetic transact normalization (v1 transact-shape port)", () => {
  it("passes vanilla transact through unchanged, retargeted at the pool", () => {
    const data = transactCalldata();
    expect(normaliseRequestToVanillaTransact(data, POOL)).toEqual({ to: POOL, data });
  });

  it("lifts the Transaction struct from atomicCrossChainUnshield into transact([tx])", () => {
    const wrapperIface = new Interface([...WRAPPER_ABIS]);
    const data = wrapperIface.encodeFunctionData("atomicCrossChainUnshield", [
      TX_STRUCT,
      6,
      "0x" + "11".repeat(20),
      "0x" + "00".repeat(32),
      100n,
    ]);
    const normalised = normaliseRequestToVanillaTransact(data, POOL);
    expect(normalised.to).toBe(POOL);
    expect(normalised.data).toBe(transactCalldata()); // byte-identical synthetic call
  });

  it("lifts from lendAndShield too, and rejects unknown selectors", () => {
    const wrapperIface = new Interface([...WRAPPER_ABIS]);
    const data = wrapperIface.encodeFunctionData("lendAndShield", [
      TX_STRUCT,
      "0x" + "22".repeat(32),
      [["0x" + "01".repeat(32), "0x" + "02".repeat(32), "0x" + "03".repeat(32)], "0x" + "04".repeat(32)],
    ]);
    expect(normaliseRequestToVanillaTransact(data, POOL).data).toBe(transactCalldata());
    expect(() => normaliseRequestToVanillaTransact("0xdeadbeef" + "00".repeat(64), POOL)).toThrow(
      RelayError,
    );
  });
});

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
    const schedule = await h.calc.getSchedule(31337);
    const result = await h.relay.relay({
      chainId: 31337,
      to: POOL.toUpperCase().replace("0X", "0x"),
      data: transactCalldata(),
      feesCacheId: schedule.cacheId,
    });
    expect(result.status).toBe("pending");
  });

  it("3. unknown/expired feesCacheId → FEE_EXPIRED (before selector validation, v1 order)", async () => {
    const h = makeHarness();
    await expectCode(
      h.relay.relay({ chainId: 31337, to: POOL, data: "0xdeadbeef00", feesCacheId: "nope" }),
      "FEE_EXPIRED",
    );
  });

  it("4. short data / disallowed selector → INVALID_DATA", async () => {
    const h = makeHarness();
    const schedule = await h.calc.getSchedule(31337);
    await expectCode(
      h.relay.relay({ chainId: 31337, to: POOL, data: "0x", feesCacheId: schedule.cacheId }),
      "INVALID_DATA",
    );
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

  it("5a. broadcaster path: USDC note below advertised → FEE_INSUFFICIENT", async () => {
    const h = makeHarness();
    h.extractorMap.value = { [USDC.toLowerCase()]: 1n };
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

  it("5b. broadcaster path: notes in another token don't count; extractor failure fails closed", async () => {
    const h = makeHarness();
    h.extractorMap.value = { ["0x" + "77".repeat(20)]: parseUnits("1000", 6) };
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
    h.extractorMap.value = null;
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

  it("5c. gasless path: wrong target → INVALID_TARGET; low fee → FEE_INSUFFICIENT; ok fee relays", async () => {
    const h = makeHarness();
    const schedule = await h.calc.getSchedule(31337);
    await expectCode(
      h.relay.relay({
        chainId: 31337,
        to: POOL, // gasless must target the configured wrapper
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

  it("8a. duplicate → DUPLICATE_TX with the prior txHash embedded (frontend regex contract)", async () => {
    const h = makeHarness();
    const schedule = await h.calc.getSchedule(31337);
    const req = {
      chainId: 31337,
      to: POOL,
      data: transactCalldata(),
      feesCacheId: schedule.cacheId,
    };
    const first = await h.relay.relay(req);
    const err = await h.relay.relay(req).catch((e: RelayError) => e);
    expect(err).toBeInstanceOf(RelayError);
    expect((err as RelayError).code).toBe("DUPLICATE_TX");
    const embedded = (err as RelayError).message.match(/0x[0-9a-fA-F]{64}/);
    expect(embedded?.[0]).toBe(first.txHash);
    // after the 10-min window the same calldata is accepted again
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
        to: WRAPPER, // different (to, data) so the dedup cache doesn't fire first
        data: gaslessCalldata(10n ** 9n),
        feesCacheId: schedule.cacheId,
      }),
      "SUBMISSION_FAILED",
    );
  });

  it("previous-schedule quotes stay valid within the variance buffer (v1 semantics)", async () => {
    const h = makeHarness();
    const first = await h.calc.getSchedule(31337);
    h.now.t = first.expiresAt + 1; // expired but within the 60s buffer
    await h.calc.getSchedule(31337); // regenerates; `first` becomes previous
    const result = await h.relay.relay({
      chainId: 31337,
      to: POOL,
      data: transactCalldata(),
      feesCacheId: first.cacheId,
    });
    expect(result.status).toBe("pending");
  });

  it("selectorOf tolerates junk", () => {
    expect(selectorOf("nope")).toBeNull();
    expect(selectorOf(transactCalldata())).toBe(SELECTOR_TRANSACT);
    expect(selectorOf(gaslessCalldata(1n))).toBe(SELECTOR_GASLESS_SHIELD);
  });
});
