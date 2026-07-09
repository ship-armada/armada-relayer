// ABOUTME: HTTP API contract tests (§9.1) via supertest: endpoint shapes, idempotency replay,
// ABOUTME: delivered cursor feed, health 200/503, rate limiting, body-size limit, no /cctp-status.
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp, type HttpDeps, type TxStatusResult } from "../src/http/server.js";
import { FeeCalculator } from "../src/relay/fee-calculator.js";
import { PrivacyRelay } from "../src/relay/privacy-relay.js";
import { DedupCache } from "../src/relay/dedup-cache.js";
import { InMemoryIdempotencyRepo } from "../src/db/idempotency-repo.js";
import { InMemoryJobsRepo } from "../src/db/jobs-repo.js";
import { newCounters } from "../src/http/health.js";
import { createMetrics } from "../src/metrics.js";
import { SELECTOR_TRANSACT } from "../src/relay/selectors.js";
import { mkJob, POOL_ADDRESS } from "./helpers.js";
import type { ChainHealthReport } from "../src/http/health.js";

const GWEI = 1_000_000_000n;
const WRAPPER = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";

interface Harness {
  app: Express;
  jobs: InMemoryJobsRepo;
  idempotency: InMemoryIdempotencyRepo;
  calc: FeeCalculator;
  chainReports: ChainHealthReport[];
  txStatusResult: { value: TxStatusResult };
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
  const chainReports: ChainHealthReport[] = [
    { chainId: 31337, status: "healthy", lastScanAt: null, lagBlocks: 0, lastIndexedBlock: "1" },
  ];
  const txStatusResult = { value: { status: "pending" } as TxStatusResult };
  const relay = new PrivacyRelay({
    targets: new Map([
      [
        31337,
        {
          chainId: 31337,
          allowlist: new Set([POOL_ADDRESS.toLowerCase(), WRAPPER.toLowerCase()]),
          wrapperAddress: WRAPPER,
        },
      ],
    ]),
    feeCalculator: calc,
    extractor: { extractFeeNoteUsdcAmount: async () => 10n ** 12n },
    submitter: {
      tryAcquire: () => true,
      release: () => {},
      estimateGas: async () => 100_000n,
      submit: async () => ({ hash: "0x" + "cc".repeat(32) }),
    },
    dedup: new DedupCache(),
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
    counters: newCounters(),
    metrics: createMetrics(),
    trustProxy: false,
    bodyLimitBytes: 256 * 1024,
    relayRatePerMin: 10,
    getRatePerMin: 60,
    ...overrides,
  });
  return { app, jobs, idempotency, calc, chainReports, txStatusResult };
}

async function freshCacheId(h: Harness): Promise<string> {
  return (await h.calc.getSchedule(31337)).cacheId;
}

describe("GET / and /fees", () => {
  it("serves the banner with the endpoint list", async () => {
    const res = await request(makeApp().app).get("/");
    expect(res.status).toBe(200);
    expect(res.body.service).toBe("armada-actor");
    expect(res.body.endpoints).toContain("/cctp/delivered");
  });

  it("/fees defaults to the hub chain and 404s unknown chains", async () => {
    const h = makeApp();
    const res = await request(h.app).get("/fees");
    expect(res.status).toBe(200);
    expect(res.body.chainId).toBe(31337);
    expect(res.body.cacheId).toMatch(/^fee-31337-/);
    expect(res.body.broadcasterRailgunAddress).toBe("0zk1test");
    expect((await request(h.app).get("/fees?chainId=999")).status).toBe(404);
  });
});

describe("POST /relay", () => {
  it("relays and returns {txHash, status: pending}", async () => {
    const h = makeApp();
    const res = await request(h.app).post("/relay").send({
      chainId: 31337,
      to: POOL_ADDRESS,
      data: SELECTOR_TRANSACT + "ab".repeat(64),
      feesCacheId: await freshCacheId(h),
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ txHash: "0x" + "cc".repeat(32), status: "pending" });
  });

  it("maps error codes to the preserved HTTP statuses", async () => {
    const h = makeApp();
    const cacheId = await freshCacheId(h);
    const cases: [object, number, string][] = [
      [{ chainId: 999, to: POOL_ADDRESS, data: "0x", feesCacheId: cacheId }, 400, "INVALID_CHAIN"],
      [
        { chainId: 31337, to: "0x" + "99".repeat(20), data: "0x", feesCacheId: cacheId },
        400,
        "INVALID_TARGET",
      ],
      [
        { chainId: 31337, to: POOL_ADDRESS, data: "0x", feesCacheId: "stale" },
        402,
        "FEE_EXPIRED",
      ],
      [
        { chainId: 31337, to: POOL_ADDRESS, data: "0xdeadbeef00", feesCacheId: cacheId },
        400,
        "INVALID_DATA",
      ],
    ];
    for (const [body, status, code] of cases) {
      const res = await request(h.app).post("/relay").send(body);
      expect(res.status).toBe(status);
      expect(res.body.error.code).toBe(code);
    }
  });

  it("idempotencyKey: first call executes, repeat returns the recorded result", async () => {
    const h = makeApp();
    const body = {
      chainId: 31337,
      to: POOL_ADDRESS,
      data: SELECTOR_TRANSACT + "ab".repeat(64),
      feesCacheId: await freshCacheId(h),
      idempotencyKey: "client-key-1",
    };
    const first = await request(h.app).post("/relay").send(body);
    expect(first.status).toBe(200);
    // repeat (would otherwise be DUPLICATE_TX) returns the recorded result
    const second = await request(h.app).post("/relay").send(body);
    expect(second.status).toBe(200);
    expect(second.body.txHash).toBe(first.body.txHash);
  });

  it("rejects idempotency keys longer than 200 chars", async () => {
    const h = makeApp();
    const res = await request(h.app).post("/relay").send({
      chainId: 31337,
      to: POOL_ADDRESS,
      data: "0x",
      feesCacheId: "x",
      idempotencyKey: "k".repeat(201),
    });
    expect(res.status).toBe(400);
  });

  it("enforces the 256 KiB body limit (S2)", async () => {
    const h = makeApp();
    const res = await request(h.app)
      .post("/relay")
      .set("content-type", "application/json")
      .send(JSON.stringify({ data: "00".repeat(300 * 1024) }));
    expect(res.status).toBe(413);
  });

  it("rate limits POST /relay per IP at the configured rate", async () => {
    const h = makeApp({ relayRatePerMin: 2 });
    const body = { chainId: 999, to: "0x", data: "0x", feesCacheId: "x" };
    await request(h.app).post("/relay").send(body);
    await request(h.app).post("/relay").send(body);
    const res = await request(h.app).post("/relay").send(body);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
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

  it("rejects malformed hashes and unknown chains", async () => {
    const h = makeApp();
    expect((await request(h.app).get("/status/nothex")).status).toBe(400);
    expect(
      (await request(h.app).get(`/status/${"0x" + "cc".repeat(32)}?chainId=5`)).status,
    ).toBe(404);
  });
});

describe("GET /cctp/delivered (§9.1, P2)", () => {
  beforeEach(() => {
    // no shared state between tests — each makeApp() builds fresh repos
  });

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
    expect(res.body.generatedAt).toBeTruthy();

    const empty = await request(h.app).get(
      `/cctp/delivered?destinationDomain=100&sinceMs=${1_750_000_000_000}`,
    );
    expect(empty.body.records).toHaveLength(0);
  });

  it("requires destinationDomain", async () => {
    const res = await request(makeApp().app).get("/cctp/delivered");
    expect(res.status).toBe(400);
  });

  it("v1's per-message /cctp-status/:messageHash MUST NOT exist (§16.1)", async () => {
    const res = await request(makeApp().app).get("/cctp-status/0xabc");
    expect(res.status).toBe(404);
  });
});

describe("GET /health (§6.6 semantics)", () => {
  it("200 healthy with pending/deadLetter counts and counters", async () => {
    const h = makeApp();
    await h.jobs.insertIfAbsent(mkJob({ dedupKey: "a:0", state: "submitted" }));
    await h.jobs.insertIfAbsent(mkJob({ dedupKey: "b:0", state: "dead_letter" }));
    const res = await request(h.app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("healthy");
    expect(res.body.pendingCount).toBe(1);
    expect(res.body.deadLetterCount).toBe(1);
    expect(res.body.counters).toHaveProperty("submitSuccess");
    expect(res.body.chains).toHaveLength(1);
  });

  it("503 only when rollup is stale or unhealthy", async () => {
    const h = makeApp();
    h.chainReports[0]!.status = "degraded";
    expect((await request(h.app).get("/health")).status).toBe(200);
    h.chainReports[0]!.status = "stale";
    expect((await request(h.app).get("/health")).status).toBe(503);
    h.chainReports[0]!.status = "unhealthy";
    expect((await request(h.app).get("/health")).status).toBe(503);
  });
});

describe("GET /metrics", () => {
  it("serves Prometheus text format", async () => {
    const res = await request(makeApp().app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.text).toContain("armada_actor_relay_submissions_total");
  });
});
