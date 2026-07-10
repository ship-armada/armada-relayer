// ABOUTME: HTTP API contract tests (v1 parity shapes from http-api.ts): flat {error, code}
// ABOUTME: bodies, endpoint shapes, idempotency replay, delivered feed, health 200/503, limits.
import { describe, it, expect } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { Interface, parseUnits } from "ethers";
import { createApp, type HttpDeps, type TxStatusResult } from "../src/http/server.js";
import { FeeCalculator } from "../src/relay/fee-calculator.js";
import { PrivacyRelay } from "../src/relay/privacy-relay.js";
import { DedupCache } from "../src/relay/dedup-cache.js";
import { InMemoryIdempotencyRepo } from "../src/db/idempotency-repo.js";
import { InMemoryJobsRepo } from "../src/db/jobs-repo.js";
import { Counters, type ChainHealthReport } from "../src/http/health.js";
import { createMetrics } from "../src/metrics.js";
import { TRANSACT_ABI } from "../src/relay/transact-shape.js";
import { mkJob, POOL_ADDRESS } from "./helpers.js";

const GWEI = 1_000_000_000n;
const WRAPPER = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
const USDC = "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9";

// Minimal valid transact calldata (fee note is faked in the extractor).
const TX_STRUCT = {
  proof: { a: { x: 1n, y: 2n }, b: { x: [1n, 2n], y: [3n, 4n] }, c: { x: 5n, y: 6n } },
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
    commitmentCiphertext: [],
  },
  unshieldPreimage: {
    npk: "0x" + "07".repeat(32),
    token: { tokenType: 0, tokenAddress: USDC, tokenSubID: 0n },
    value: 100n,
  },
};
const TRANSACT_DATA = new Interface([...TRANSACT_ABI]).encodeFunctionData("transact", [[TX_STRUCT]]);

function healthyChain(): ChainHealthReport {
  return {
    chainName: "hub",
    domain: 100,
    status: "healthy",
    lastProcessedBlock: 100,
    chainHead: 100,
    lagBlocks: 0,
    lastScanAt: 1_750_000_000_000,
    lastError: null,
    pendingCount: 0,
    deadLetterCount: 0,
  };
}

interface Harness {
  app: Express;
  jobs: InMemoryJobsRepo;
  idempotency: InMemoryIdempotencyRepo;
  calc: FeeCalculator;
  chainReports: ChainHealthReport[];
  txStatusResult: { value: TxStatusResult };
  counters: Counters;
}

function makeApp(overrides: Partial<HttpDeps> = {}): Harness {
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
  const jobs = new InMemoryJobsRepo();
  const idempotency = new InMemoryIdempotencyRepo();
  const counters = new Counters();
  const chainReports: ChainHealthReport[] = [healthyChain()];
  const txStatusResult = { value: { status: "pending" } as TxStatusResult };
  const relay = new PrivacyRelay({
    allowedTargets: new Map([
      [31337, new Set([POOL_ADDRESS.toLowerCase(), WRAPPER.toLowerCase()])],
    ]),
    feeCalculator: calc,
    gaslessCtx: { wrappersByChain: new Map([[31337, WRAPPER]]) },
    broadcasterCtx: {
      extractor: {
        extractFirstNoteERC20AmountMap: async () => ({
          [USDC.toLowerCase()]: parseUnits("1000", 6),
        }),
      },
      privacyPoolAddress: POOL_ADDRESS,
      usdcAddress: USDC,
    },
    submitter: {
      tryAcquire: () => true,
      release: () => {},
      estimateGas: async () => 100_000n,
      submit: async () => ({ hash: "0x" + "cc".repeat(32) }),
    },
    dedup: new DedupCache(),
    counters,
  });
  const app = createApp({
    hubChainId: 31337,
    configuredChainIds: [31337, 31338, 31339],
    feeCalculator: calc,
    relay,
    idempotency,
    jobs,
    txStatus: async () => txStatusResult.value,
    chainHealth: async () => chainReports,
    counters,
    metrics: createMetrics(),
    trustProxy: false,
    bodyLimitBytes: 256 * 1024,
    relayRatePerMin: 10,
    getRatePerMin: 60,
    ...overrides,
  });
  return { app, jobs, idempotency, calc, chainReports, txStatusResult, counters };
}

async function freshCacheId(h: Harness): Promise<string> {
  return (await h.calc.getSchedule(31337)).cacheId;
}

describe("GET / and /fees", () => {
  it("serves the v1-style banner", async () => {
    const res = await request(makeApp().app).get("/");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("running");
    expect(res.body.endpoints).toContain("POST /relay");
    expect(res.body.endpoints).toContain("GET /cctp/delivered");
    expect(res.body.endpoints).not.toContain("GET /cctp-status/:messageHash"); // §16.1
  });

  it("/fees defaults to the hub chain; unknown chain → 404 {error, supported}", async () => {
    const h = makeApp();
    const res = await request(h.app).get("/fees");
    expect(res.status).toBe(200);
    expect(res.body.chainId).toBe(31337);
    expect(res.body.cacheId).toMatch(/^fee-31337-/);
    expect(res.body.broadcasterRailgunAddress).toBe("0zk1test");
    for (const v of Object.values(res.body.fees as Record<string, string>)) {
      expect(v).toMatch(/^\d+$/);
    }
    const missing = await request(h.app).get("/fees?chainId=999");
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({
      error: "No fee schedule for chain 999",
      supported: [31337, 31338, 31339],
    });
  });
});

describe("POST /relay", () => {
  it("relays and returns {txHash, status: pending}", async () => {
    const h = makeApp();
    const res = await request(h.app).post("/relay").send({
      chainId: 31337,
      to: POOL_ADDRESS,
      data: TRANSACT_DATA,
      feesCacheId: await freshCacheId(h),
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ txHash: "0x" + "cc".repeat(32), status: "pending" });
    expect(h.counters.snapshot()["submitSuccess.transact"]).toBe(1);
  });

  it("missing fields → 400 with the v1 message", async () => {
    const res = await request(makeApp().app).post("/relay").send({ chainId: 31337 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Missing required fields: chainId, to, data, feesCacheId",
    });
  });

  it("maps error codes to statuses with FLAT {error, code} bodies (v1 shape)", async () => {
    const h = makeApp();
    const cacheId = await freshCacheId(h);
    const cases: [object, number, string][] = [
      [{ chainId: 999, to: POOL_ADDRESS, data: "0x00", feesCacheId: cacheId }, 400, "INVALID_CHAIN"],
      [
        { chainId: 31337, to: "0x" + "99".repeat(20), data: "0x00", feesCacheId: cacheId },
        400,
        "INVALID_TARGET",
      ],
      [{ chainId: 31337, to: POOL_ADDRESS, data: "0x00", feesCacheId: "stale" }, 402, "FEE_EXPIRED"],
      [
        { chainId: 31337, to: POOL_ADDRESS, data: "0xdeadbeef00", feesCacheId: cacheId },
        400,
        "INVALID_DATA",
      ],
    ];
    for (const [body, status, code] of cases) {
      const res = await request(h.app).post("/relay").send(body);
      expect(res.status).toBe(status);
      expect(res.body.code).toBe(code);
      expect(typeof res.body.error).toBe("string"); // flat, not nested
    }
    // v1 semantics: validation-stage rejects (steps 1-4) increment NO counters;
    // feeVerifierRejects.<CODE> comes only from the verifier step (5).
    expect(h.counters.snapshot()).toEqual({});
  });

  it("counters follow v1 sites: verifier rejects counted, validation rejects not", async () => {
    const h = makeApp();
    const cacheId = await freshCacheId(h);
    // FEE_EXPIRED (step 3) — no counter
    await request(h.app)
      .post("/relay")
      .send({ chainId: 31337, to: POOL_ADDRESS, data: "0x00", feesCacheId: "stale" });
    // gasless below advertised (step 5) — feeVerifierRejects.FEE_INSUFFICIENT
    const GASLESS_IFACE = new Interface([
      "function gaslessShield(address user, uint256 totalAmount, uint256 fee, uint256 deadline, uint8 v, bytes32 r, bytes32 s, ((bytes32,(uint8,address,uint256),uint120),(bytes32[3],bytes32)) shieldRequest, address integrator)",
    ]);
    const lowFee = GASLESS_IFACE.encodeFunctionData("gaslessShield", [
      "0x" + "11".repeat(20), 1000n, 1n, 9999n, 27, "0x" + "01".repeat(32), "0x" + "02".repeat(32),
      [["0x" + "03".repeat(32), [0, USDC, 0n], 500n],
       [["0x" + "04".repeat(32), "0x" + "05".repeat(32), "0x" + "06".repeat(32)], "0x" + "07".repeat(32)]],
      "0x" + "00".repeat(20),
    ]);
    await request(h.app)
      .post("/relay")
      .send({ chainId: 31337, to: WRAPPER, data: lowFee, feesCacheId: cacheId });
    expect(h.counters.snapshot()).toEqual({ "feeVerifierRejects.FEE_INSUFFICIENT": 1 });
  });

  it("idempotencyKey: first call executes, repeat returns the recorded result", async () => {
    const h = makeApp();
    const body = {
      chainId: 31337,
      to: POOL_ADDRESS,
      data: TRANSACT_DATA,
      feesCacheId: await freshCacheId(h),
      idempotencyKey: "client-key-1",
    };
    const first = await request(h.app).post("/relay").send(body);
    expect(first.status).toBe(200);
    const second = await request(h.app).post("/relay").send(body);
    expect(second.status).toBe(200);
    expect(second.body.txHash).toBe(first.body.txHash);
    expect(h.counters.snapshot()["idempotentReplay"]).toBe(1);
  });

  it("invalid idempotencyKey → 400 {error, code} (v1 message)", async () => {
    const res = await request(makeApp().app).post("/relay").send({
      chainId: 31337,
      to: POOL_ADDRESS,
      data: "0x00",
      feesCacheId: "x",
      idempotencyKey: "k".repeat(201),
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid idempotencyKey", code: "INVALID_DATA" });
  });

  it("enforces the 256 KiB body limit (S2)", async () => {
    const res = await request(makeApp().app)
      .post("/relay")
      .set("content-type", "application/json")
      .send(JSON.stringify({ data: "00".repeat(300 * 1024) }));
    expect(res.status).toBe(413);
  });

  it("rate limits POST /relay with the v1 429 body", async () => {
    const h = makeApp({ relayRatePerMin: 2 });
    const body = { chainId: 999, to: "0x", data: "0x", feesCacheId: "x" };
    await request(h.app).post("/relay").send(body);
    await request(h.app).post("/relay").send(body);
    const res = await request(h.app).post("/relay").send(body);
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: "Too many requests — slow down.", code: "RATE_LIMITED" });
  });
});

describe("GET /status/:txHash", () => {
  it("returns the tx status and backfills terminal idempotency status", async () => {
    const h = makeApp();
    await h.idempotency.put({
      key: "k1",
      txHash: "0x" + "cc".repeat(32),
      status: "pending",
      chainId: 31337,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    h.txStatusResult.value = { status: "confirmed", blockNumber: 7 };
    const res = await request(h.app).get(`/status/${"0x" + "cc".repeat(32)}`);
    expect(res.body).toEqual({ status: "confirmed", blockNumber: 7 });
    expect((await h.idempotency.get("k1"))!.status).toBe("confirmed");
  });

  it("v1 validation bodies: bad hash and bad chainId", async () => {
    const h = makeApp();
    const bad = await request(h.app).get("/status/nothex");
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: "Invalid transaction hash" });
    const badChain = await request(h.app).get(`/status/${"0x" + "cc".repeat(32)}?chainId=5`);
    expect(badChain.status).toBe(400);
    expect(badChain.body).toEqual({ error: "Invalid chainId: 5" });
  });
});

describe("GET /cctp/delivered (§9.1, P2)", () => {
  it("serves delivered records for a destination domain since a cursor", async () => {
    const h = makeApp();
    await h.jobs.insertIfAbsent(
      mkJob({
        dedupKey: "0xaaa:0",
        state: "delivered",
        destinationDomain: 100,
        deliveredTxHash: "0xdd",
        deliveredBlock: 88n,
        deliveredAt: new Date(1_750_000_000_000),
      }),
    );
    const res = await request(h.app).get("/cctp/delivered?destinationDomain=100&sinceMs=0");
    expect(res.status).toBe(200);
    expect(res.body.records).toHaveLength(1);
    expect(res.body.records[0]).toMatchObject({
      dedupKey: "0xaaa:0",
      sourceDomain: 101,
      destinationDomain: 100,
      destinationTxHash: "0xdd",
      destinationBlock: "88",
      deliveredAt: 1_750_000_000_000,
    });
    expect(typeof res.body.generatedAt).toBe("number");

    const empty = await request(h.app).get(
      `/cctp/delivered?destinationDomain=100&sinceMs=${1_750_000_000_000}`,
    );
    expect(empty.body.records).toHaveLength(0);
  });

  it("requires destinationDomain", async () => {
    expect((await request(makeApp().app).get("/cctp/delivered")).status).toBe(400);
  });

  it("v1's per-message /cctp-status/:messageHash MUST NOT exist (§16.1)", async () => {
    expect((await request(makeApp().app).get("/cctp-status/0xabc")).status).toBe(404);
  });
});

describe("GET /health (v1 RelayerHealth shape)", () => {
  it("200 healthy with v1 chain rows, numeric generatedAt, dotted counters", async () => {
    const h = makeApp();
    h.counters.inc("submitSuccess.transact");
    const res = await request(h.app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("healthy");
    expect(res.body.chains[0]).toMatchObject({
      chainName: "hub",
      domain: 100,
      status: "healthy",
      lastProcessedBlock: 100,
      chainHead: 100,
      lagBlocks: 0,
      lastError: null,
      pendingCount: 0,
      deadLetterCount: 0,
    });
    expect(typeof res.body.generatedAt).toBe("number");
    expect(res.body.counters).toEqual({ "submitSuccess.transact": 1 });
  });

  it("v1 status codes: 200 healthy/degraded, 503 stale/unhealthy — same body", async () => {
    const h = makeApp();
    h.chainReports[0]!.status = "degraded";
    expect((await request(h.app).get("/health")).status).toBe(200);
    h.chainReports[0]!.status = "stale";
    const res = await request(h.app).get("/health");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("stale"); // body still present on 503
    h.chainReports[0]!.status = "unhealthy";
    expect((await request(h.app).get("/health")).status).toBe(503);
  });

  it("is not rate-limited (v1)", async () => {
    const h = makeApp({ getRatePerMin: 1 });
    for (let i = 0; i < 5; i++) {
      expect((await request(h.app).get("/health")).status).toBe(200);
    }
  });
});

describe("GET /metrics", () => {
  it("serves Prometheus text format", async () => {
    const res = await request(makeApp().app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.text).toContain("armada_actor_relay_submissions_total");
  });
});
