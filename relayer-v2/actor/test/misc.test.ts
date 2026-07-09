// ABOUTME: Unit tests for the smaller actor components: rate limiter (§6.3), nonce coordinator
// ABOUTME: (§6.5), selectors/gasless decoding (§6.2.4-5), health classification (§6.6), iris client.
import { describe, it, expect } from "vitest";
import { TokenBucketLimiter } from "../src/http/rate-limiter.js";
import { NonceCoordinator } from "../src/wallet/nonce-coordinator.js";
import {
  ALLOWED_SELECTORS,
  SELECTOR_TRANSACT,
  SELECTOR_LEND_AND_SHIELD,
  SELECTOR_REDEEM_AND_SHIELD,
  SELECTOR_ATOMIC_XCHAIN_UNSHIELD,
  SELECTOR_GASLESS_SHIELD,
  SELECTOR_GASLESS_XCHAIN_SHIELD,
  decodeGaslessFee,
  advertisedFeeKeys,
  selectorOf,
} from "../src/relay/selectors.js";
import { classifyChain, rollup, healthHttpStatus } from "../src/http/health.js";
import { IrisClient, MockAttestationClient, MOCK_ATTESTATION } from "../src/jobs/iris-client.js";
import { assertValidMnemonic } from "../src/wallet/railgun-wallet.js";
import { Interface } from "ethers";

describe("TokenBucketLimiter (§6.3)", () => {
  it("allows capacity burst then rejects, refilling at capacity/60 per second", () => {
    const clock = { t: 0 };
    const limiter = new TokenBucketLimiter(10, () => clock.t);
    for (let i = 0; i < 10; i++) expect(limiter.allow("ip1")).toBe(true);
    expect(limiter.allow("ip1")).toBe(false);
    clock.t += 6000; // 6s → refill 1 token (10/60 per sec)
    expect(limiter.allow("ip1")).toBe(true);
    expect(limiter.allow("ip1")).toBe(false);
  });

  it("buckets are per key", () => {
    const limiter = new TokenBucketLimiter(1, () => 0);
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("b")).toBe(true);
    expect(limiter.allow("a")).toBe(false);
  });
});

describe("NonceCoordinator (§6.5)", () => {
  it("seeds from the pending count and serializes increments", async () => {
    const coordinator = new NonceCoordinator(async () => 7);
    const nonces: number[] = [];
    await Promise.all([
      coordinator.withNonce(1, async (n) => nonces.push(n)),
      coordinator.withNonce(1, async (n) => nonces.push(n)),
      coordinator.withNonce(1, async (n) => nonces.push(n)),
    ]);
    expect(nonces).toEqual([7, 8, 9]);
  });

  it("does not advance on broadcast failure (nonce reused)", async () => {
    const coordinator = new NonceCoordinator(async () => 0);
    await expect(
      coordinator.withNonce(1, async () => {
        throw new Error("broadcast failed");
      }),
    ).rejects.toThrow();
    let seen = -1;
    await coordinator.withNonce(1, async (n) => (seen = n));
    expect(seen).toBe(0);
  });

  it("reset re-seeds the stream (stuck-tx recovery)", async () => {
    let seed = 5;
    const coordinator = new NonceCoordinator(async () => seed);
    await coordinator.withNonce(1, async () => {});
    seed = 42;
    coordinator.reset(1);
    let seen = -1;
    await coordinator.withNonce(1, async (n) => (seen = n));
    expect(seen).toBe(42);
  });

  it("streams are per chain", async () => {
    const coordinator = new NonceCoordinator(async (chainId) => chainId * 10);
    let a = -1;
    let b = -1;
    await coordinator.withNonce(1, async (n) => (a = n));
    await coordinator.withNonce(2, async (n) => (b = n));
    expect(a).toBe(10);
    expect(b).toBe(20);
  });
});

describe("selectors (§6.2.4)", () => {
  it("pins the four spec-given selectors verbatim", () => {
    expect(SELECTOR_TRANSACT).toBe("0xd8ae136a");
    expect(SELECTOR_LEND_AND_SHIELD).toBe("0xf2987ad1");
    expect(SELECTOR_REDEEM_AND_SHIELD).toBe("0x0793b70e");
    expect(SELECTOR_ATOMIC_XCHAIN_UNSHIELD).toBe("0xe484d408");
    expect(ALLOWED_SELECTORS.size).toBe(6);
  });

  it("decodes the gaslessShield plaintext fee (arg index 2)", () => {
    const iface = new Interface([
      "function gaslessShield(bytes shieldRequest, address token, uint256 fee, bytes permit)",
    ]);
    const data = iface.encodeFunctionData("gaslessShield", [
      "0xab",
      "0x" + "11".repeat(20),
      12345n,
      "0x",
    ]);
    expect(selectorOf(data)).toBe(SELECTOR_GASLESS_SHIELD);
    expect(decodeGaslessFee(SELECTOR_GASLESS_SHIELD, data)).toBe(12345n);
  });

  it("decodes the gaslessCrossChainShield fee (permitInput[2])", () => {
    const iface = new Interface([
      "function gaslessCrossChainShield(bytes shieldRequest, uint32 destinationDomain, (uint256 amount, uint256 deadline, uint256 fee) permitInput, bytes permit)",
    ]);
    const data = iface.encodeFunctionData("gaslessCrossChainShield", [
      "0xab",
      6,
      { amount: 1n, deadline: 2n, fee: 999n },
      "0x",
    ]);
    expect(decodeGaslessFee(SELECTOR_GASLESS_XCHAIN_SHIELD, data)).toBe(999n);
  });

  it("advertised fee mapping: transact quotes min(transfer, unshield)", () => {
    expect(advertisedFeeKeys(SELECTOR_TRANSACT)).toEqual(["transfer", "unshield"]);
    expect(advertisedFeeKeys(SELECTOR_GASLESS_SHIELD)).toEqual(["shield"]);
  });
});

describe("health classification (§6.6)", () => {
  const base = { chainId: 1, pollIntervalMs: 1000, nominalBlockTimeMs: 1000 };
  const progressAt = (ageMs: number, now: number) => ({
    chainId: 1,
    lastIndexedBlock: 100n,
    lastIndexedBlockTimestamp: new Date(now - ageMs),
    ready: true,
  });

  it("never scanned → unhealthy", () => {
    expect(classifyChain(0, { ...base, progress: undefined }).status).toBe("unhealthy");
  });

  it("> 10× poll → unhealthy; > 3× poll → stale; fresh → healthy", () => {
    const now = 1_000_000;
    expect(classifyChain(now, { ...base, progress: progressAt(10_001, now) }).status).toBe(
      "unhealthy",
    );
    expect(classifyChain(now, { ...base, progress: progressAt(3_001, now) }).status).toBe("stale");
    expect(classifyChain(now, { ...base, progress: progressAt(500, now) }).status).toBe("healthy");
  });

  it("errored tick or lag > 100 blocks → degraded", () => {
    const now = 1_000_000;
    expect(
      classifyChain(now, { ...base, progress: progressAt(500, now), lastTickErrored: true }).status,
    ).toBe("degraded");
  });

  it("rollup is worst-wins; 503 only for stale/unhealthy", () => {
    expect(
      rollup([
        { chainId: 1, status: "healthy", lastScanAt: null, lagBlocks: 0, lastIndexedBlock: null },
        { chainId: 2, status: "degraded", lastScanAt: null, lagBlocks: 0, lastIndexedBlock: null },
      ]),
    ).toBe("degraded");
    expect(healthHttpStatus("healthy")).toBe(200);
    expect(healthHttpStatus("degraded")).toBe(200);
    expect(healthHttpStatus("stale")).toBe(503);
    expect(healthHttpStatus("unhealthy")).toBe(503);
  });
});

describe("attestation clients", () => {
  it("mock client attests immediately with the mock bytes", async () => {
    const result = await new MockAttestationClient().fetch();
    expect(result).toEqual({ status: "complete", attestation: MOCK_ATTESTATION });
  });

  it("iris client maps 404 → pending, complete → complete, 5xx → error", async () => {
    const responses: [number, unknown][] = [
      [404, {}],
      [200, { status: "complete", attestation: "0xbeef" }],
      [500, {}],
      [200, { status: "pending_confirmations" }],
    ];
    let i = 0;
    const client = new IrisClient("https://iris.test", (async () => {
      const [status, body] = responses[i++]!;
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch);
    expect(await client.fetch("0xhash")).toEqual({ status: "pending" });
    expect(await client.fetch("0xhash")).toEqual({ status: "complete", attestation: "0xbeef" });
    expect((await client.fetch("0xhash")).status).toBe("error");
    expect(await client.fetch("0xhash")).toEqual({ status: "pending" });
  });
});

describe("decodePonderCheckpoint", () => {
  it("decodes ponder's fixed-width checkpoint string", async () => {
    const { decodePonderCheckpoint } = await import("../src/db/indexed-reader.js");
    const checkpoint =
      "1750000000" + // blockTimestamp
      "0000000000031338" + // chainId
      "0000000000000123" + // blockNumber
      "0000000000000000" + // transactionIndex
      "5" + // eventType
      "0000000000000000"; // eventIndex
    expect(decodePonderCheckpoint(checkpoint)).toEqual({
      blockTimestamp: 1_750_000_000n,
      chainId: 31338n,
      blockNumber: 123n,
    });
    expect(decodePonderCheckpoint("junk")).toBeNull();
  });
});

describe("railgun mnemonic validation (§6.5)", () => {
  it("boot-fails without a mnemonic and on wrong word counts", () => {
    expect(() => assertValidMnemonic(null)).toThrow(/RELAYER_RAILGUN_MNEMONIC is required/);
    expect(() => assertValidMnemonic("one two three")).toThrow(/12 or 24 words/);
    expect(() => assertValidMnemonic(Array(12).fill("test").join(" "))).not.toThrow();
    expect(() => assertValidMnemonic(Array(24).fill("test").join(" "))).not.toThrow();
  });
});
