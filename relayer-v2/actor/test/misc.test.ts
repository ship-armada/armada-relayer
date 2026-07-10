// ABOUTME: Unit tests for the smaller actor components: rate limiter (§6.3), nonce coordinator
// ABOUTME: (§6.5), selectors/gasless decoding (v1 signatures), health/counters, iris client (v1 port).
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
import {
  classifyChain,
  rollup,
  healthHttpStatus,
  Counters,
  type ChainHealthInput,
} from "../src/http/health.js";
import {
  IrisClient,
  MockAttestationClient,
  MOCK_ATTESTATION,
  irisMessageMatches,
  isPlausibleHexBytes,
} from "../src/jobs/iris-client.js";
import { assertValidMnemonic } from "../src/wallet/railgun-wallet.js";
import { Interface } from "ethers";
import { buildCctpMessage } from "./helpers.js";

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

describe("selectors (v1 transact-shape + gasless-fee-verifier)", () => {
  it("pins the four spec-given selectors verbatim", () => {
    expect(SELECTOR_TRANSACT).toBe("0xd8ae136a");
    expect(SELECTOR_LEND_AND_SHIELD).toBe("0xf2987ad1");
    expect(SELECTOR_REDEEM_AND_SHIELD).toBe("0x0793b70e");
    expect(SELECTOR_ATOMIC_XCHAIN_UNSHIELD).toBe("0xe484d408");
    expect(ALLOWED_SELECTORS.size).toBe(6);
  });

  it("derives the gasless selectors from the real wrapper signatures", () => {
    // cast sig of GaslessShieldWrapper.gaslessShield / GaslessShieldWrapperClient.gaslessCrossChainShield
    expect(SELECTOR_GASLESS_SHIELD).toBe("0x1de05794");
    expect(SELECTOR_GASLESS_XCHAIN_SHIELD).toBe("0xa608b736");
  });

  it("decodes the gaslessShield plaintext fee (flat arg index 2)", () => {
    const iface = new Interface([
      "function gaslessShield(address user, uint256 totalAmount, uint256 fee, uint256 deadline, uint8 v, bytes32 r, bytes32 s, ((bytes32,(uint8,address,uint256),uint120),(bytes32[3],bytes32)) shieldRequest, address integrator)",
    ]);
    const data = iface.encodeFunctionData("gaslessShield", [
      "0x" + "11".repeat(20),
      1000n,
      12345n,
      9999n,
      27,
      "0x" + "01".repeat(32),
      "0x" + "02".repeat(32),
      [
        ["0x" + "03".repeat(32), [0, "0x" + "04".repeat(20), 0n], 500n],
        [["0x" + "05".repeat(32), "0x" + "06".repeat(32), "0x" + "07".repeat(32)], "0x" + "08".repeat(32)],
      ],
      "0x" + "09".repeat(20),
    ]);
    expect(selectorOf(data)).toBe(SELECTOR_GASLESS_SHIELD);
    expect(decodeGaslessFee(SELECTOR_GASLESS_SHIELD, data)).toBe(12345n);
  });

  it("decodes the gaslessCrossChainShield fee (permitInput[2])", () => {
    const iface = new Interface([
      "function gaslessCrossChainShield((address user, uint256 totalAmount, uint256 fee, uint256 deadline, uint8 v, bytes32 r, bytes32 s) permitInput, (uint256 maxFee, uint32 minFinalityThreshold, bytes32 npk, bytes32[3] encryptedBundle, bytes32 shieldKey, bytes32 destinationCaller, address integrator) dest)",
    ]);
    const data = iface.encodeFunctionData("gaslessCrossChainShield", [
      ["0x" + "11".repeat(20), 1000n, 999n, 8888n, 27, "0x" + "01".repeat(32), "0x" + "02".repeat(32)],
      [
        50n,
        1000,
        "0x" + "03".repeat(32),
        ["0x" + "04".repeat(32), "0x" + "05".repeat(32), "0x" + "06".repeat(32)],
        "0x" + "07".repeat(32),
        "0x" + "00".repeat(32),
        "0x" + "09".repeat(20),
      ],
    ]);
    expect(selectorOf(data)).toBe(SELECTOR_GASLESS_XCHAIN_SHIELD);
    expect(decodeGaslessFee(SELECTOR_GASLESS_XCHAIN_SHIELD, data)).toBe(999n);
  });

  it("advertised fee mapping: transact quotes min(transfer, unshield); rest per v1", () => {
    expect(advertisedFeeKeys(SELECTOR_TRANSACT)).toEqual(["transfer", "unshield"]);
    expect(advertisedFeeKeys(SELECTOR_LEND_AND_SHIELD)).toEqual(["crossContract"]);
    expect(advertisedFeeKeys(SELECTOR_ATOMIC_XCHAIN_UNSHIELD)).toEqual(["crossChainUnshield"]);
    expect(advertisedFeeKeys(SELECTOR_GASLESS_SHIELD)).toEqual(["shield"]);
    expect(advertisedFeeKeys(SELECTOR_GASLESS_XCHAIN_SHIELD)).toEqual(["shieldXchain"]);
  });
});

describe("health classification (§6.6, v1 ChainHealth shape)", () => {
  const base = {
    chainName: "hub",
    domain: 100,
    pollIntervalMs: 1000,
    nominalBlockTimeMs: 1000,
    pendingCount: 0,
    deadLetterCount: 0,
  };
  const progressAt = (ageMs: number, now: number) => ({
    chainId: 1,
    lastIndexedBlock: 100n,
    lastIndexedBlockTimestamp: new Date(now - ageMs),
    ready: true,
  });
  const classify = (now: number, input: Partial<ChainHealthInput>) =>
    classifyChain(now, { ...base, progress: undefined, ...input });

  it("never scanned → unhealthy with v1 field names", () => {
    const report = classify(0, {});
    expect(report.status).toBe("unhealthy");
    expect(report).toMatchObject({
      chainName: "hub",
      domain: 100,
      lastProcessedBlock: 0,
      lastScanAt: 0,
      lastError: null,
      pendingCount: 0,
      deadLetterCount: 0,
    });
  });

  it("> 10× poll → unhealthy; > 3× poll → stale; fresh → healthy", () => {
    const now = 1_000_000;
    expect(classify(now, { progress: progressAt(10_001, now) }).status).toBe("unhealthy");
    expect(classify(now, { progress: progressAt(3_001, now) }).status).toBe("stale");
    expect(classify(now, { progress: progressAt(500, now) }).status).toBe("healthy");
  });

  it("errored tick → degraded; chainHead derives from lag estimate", () => {
    const now = 1_000_000;
    const report = classify(now, { progress: progressAt(500, now), lastTickErrored: true });
    expect(report.status).toBe("degraded");
    expect(report.chainHead).toBe(report.lastProcessedBlock + report.lagBlocks);
  });

  it("rollup worst-wins; v1 status codes: 200 healthy/degraded, 503 stale/unhealthy", () => {
    const mk = (status: "healthy" | "degraded") => ({ ...classify(0, {}), status });
    expect(rollup([mk("healthy"), mk("degraded")])).toBe("degraded");
    expect(healthHttpStatus("healthy")).toBe(200);
    expect(healthHttpStatus("degraded")).toBe(200);
    expect(healthHttpStatus("stale")).toBe(503);
    expect(healthHttpStatus("unhealthy")).toBe(503);
  });

  it("Counters uses v1's dotted-key scheme", () => {
    const counters = new Counters();
    counters.inc("submitSuccess.transact");
    counters.inc("submitFail.transact.FEE_EXPIRED");
    counters.inc("feeVerifierRejects.FEE_INSUFFICIENT");
    counters.inc("rateLimited");
    counters.inc("rateLimited");
    expect(counters.snapshot()).toEqual({
      "submitSuccess.transact": 1,
      "submitFail.transact.FEE_EXPIRED": 1,
      "feeVerifierRejects.FEE_INSUFFICIENT": 1,
      rateLimited: 2,
    });
  });
});

describe("attestation clients (v1 IrisApiClient port)", () => {
  const MESSAGE = buildCctpMessage();
  const QUERY = { sourceDomain: 101, sourceTxHash: "0x" + "11".repeat(32), expectedMessageHex: MESSAGE };

  it("mock client attests immediately with EMPTY attestation bytes (v1 mock)", async () => {
    const result = await new MockAttestationClient().fetch(QUERY);
    expect(result).toEqual({ status: "complete", attestation: "0x", message: MESSAGE });
    expect(MOCK_ATTESTATION).toBe("0x");
  });

  it("queries /v2/messages/{sourceDomain}?transactionHash= (v1 URL)", async () => {
    let url = "";
    const client = new IrisClient("https://iris.test", (async (u: string) => {
      url = u;
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch);
    await client.fetch(QUERY);
    expect(url).toBe(`https://iris.test/v2/messages/101?transactionHash=${QUERY.sourceTxHash}`);
  });

  it("maps 404 → pending; complete+matching → complete; 5xx → error", async () => {
    const attestation = "0x" + "ab".repeat(65);
    const responses: [number, unknown][] = [
      [404, {}],
      [200, { messages: [{ status: "complete", attestation, message: MESSAGE }] }],
      [500, {}],
      [200, { messages: [{ status: "pending_confirmations", message: MESSAGE }] }],
    ];
    let i = 0;
    const client = new IrisClient("https://iris.test", (async () => {
      const [status, body] = responses[i++]!;
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch);
    expect((await client.fetch(QUERY)).status).toBe("pending");
    expect(await client.fetch(QUERY)).toEqual({ status: "complete", attestation, message: MESSAGE });
    expect((await client.fetch(QUERY)).status).toBe("error");
    expect((await client.fetch(QUERY)).status).toBe("pending");
  });

  it("rejects implausible attestations and non-matching Iris messages (fail closed)", async () => {
    const shortAttestation = "0x1234";
    const foreignMessage = buildCctpMessage({ destinationDomain: 99 });
    const responses = [
      { messages: [{ status: "complete", attestation: shortAttestation, message: MESSAGE }] },
      { messages: [{ status: "complete", attestation: "0x" + "ab".repeat(65), message: foreignMessage }] },
    ];
    let i = 0;
    const client = new IrisClient("https://iris.test", (async () =>
      new Response(JSON.stringify(responses[i++]), { status: 200 })) as unknown as typeof fetch);
    expect((await client.fetch(QUERY)).status).toBe("error"); // implausible attestation
    expect((await client.fetch(QUERY)).status).toBe("error"); // bytes mismatch
  });

  it("selects the matching entry when a tx emitted multiple messages", async () => {
    const other = buildCctpMessage({ destinationDomain: 99 });
    const attestation = "0x" + "cd".repeat(65);
    const body = {
      messages: [
        { status: "complete", attestation: "0x" + "ab".repeat(65), message: other },
        { status: "complete", attestation, message: MESSAGE },
      ],
    };
    const client = new IrisClient("https://iris.test", (async () =>
      new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch);
    expect(await client.fetch(QUERY)).toEqual({ status: "complete", attestation, message: MESSAGE });
  });

  it("irisMessageMatches ignores exactly the nonce and finality slots (v1)", () => {
    const local = buildCctpMessage();
    const withNonce = buildCctpMessage({ nonce: "0x" + "ee".repeat(32) });
    expect(irisMessageMatches(local, withNonce)).toBe(true);
    expect(irisMessageMatches(local, buildCctpMessage({ destinationDomain: 99 }))).toBe(false);
    expect(irisMessageMatches(local, local + "ff")).toBe(false); // length must match
  });

  it("isPlausibleHexBytes validates hex-ness and minimum size", () => {
    expect(isPlausibleHexBytes("0x" + "ab".repeat(65), 65)).toBe(true);
    expect(isPlausibleHexBytes("0x" + "ab".repeat(64), 65)).toBe(false);
    expect(isPlausibleHexBytes("0xzz", 1)).toBe(false);
    expect(isPlausibleHexBytes(42, 1)).toBe(false);
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
