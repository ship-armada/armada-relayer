// ABOUTME: Actor HTTP API (§9.1) — the v1-parity public surface: /, /fees, /relay, /status,
// ABOUTME: /health plus the new /cctp/delivered cursor feed (P2) and Prometheus /metrics.
import express, { type Express, type Request, type Response } from "express";
import type { FeeCalculator } from "../relay/fee-calculator.js";
import type { PrivacyRelay, RelayRequest } from "../relay/privacy-relay.js";
import type { IdempotencyRepo } from "../db/idempotency-repo.js";
import type { JobsRepo } from "../db/jobs-repo.js";
import { RelayError } from "./errors.js";
import { TokenBucketLimiter, rateLimitMiddleware } from "./rate-limiter.js";
import type { ChainHealthReport, HealthCounters } from "./health.js";
import { healthHttpStatus, rollup } from "./health.js";
import type { ActorMetrics } from "../metrics.js";
import { logger } from "../logger.js";

export interface TxStatusResult {
  status: "pending" | "confirmed" | "failed";
  blockNumber?: number;
  error?: string;
}

export interface HttpDeps {
  hubChainId: number;
  configuredChainIds: number[];
  feeCalculator: FeeCalculator;
  relay: PrivacyRelay;
  idempotency: IdempotencyRepo;
  jobs: JobsRepo;
  /** Receipt lookup for /status — fan-out across chains when chainId omitted (§9.1). */
  txStatus: (txHash: string, chainId?: number) => Promise<TxStatusResult>;
  chainHealth: () => Promise<ChainHealthReport[]>;
  counters: HealthCounters;
  metrics: ActorMetrics;
  trustProxy: boolean;
  bodyLimitBytes: number;
  relayRatePerMin: number;
  getRatePerMin: number;
  now?: () => Date;
}

const IDEMPOTENCY_KEY_MAX = 200;

export function createApp(deps: HttpDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  if (deps.trustProxy) app.set("trust proxy", true);
  app.use(express.json({ limit: deps.bodyLimitBytes })); // 256 KiB default (S2)
  const now = deps.now ?? (() => new Date());

  // CORS: public read/write API, no cookies/auth (P3).
  app.use((req, res, next) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  // Request duration metric — route template only, never client identity (P4).
  app.use((req, res, next) => {
    const startNs = process.hrtime.bigint();
    res.on("finish", () => {
      const seconds = Number(process.hrtime.bigint() - startNs) / 1e9;
      const route = req.route?.path ?? req.path.split("/").slice(0, 3).join("/");
      deps.metrics.observeHttp(route, req.method, res.statusCode, seconds);
    });
    next();
  });

  const relayLimiter = new TokenBucketLimiter(deps.relayRatePerMin);
  const getLimiter = new TokenBucketLimiter(deps.getRatePerMin);
  const onLimited = (endpoint: string): void => {
    deps.counters.rateLimited += 1;
    deps.metrics.rateLimited(endpoint);
  };
  const relayLimit = rateLimitMiddleware(relayLimiter, "/relay", deps.trustProxy, onLimited);
  const getLimit = (endpoint: string) =>
    rateLimitMiddleware(getLimiter, endpoint, deps.trustProxy, onLimited);

  app.get("/", getLimit("/"), (_req, res) => {
    res.json({
      service: "armada-actor",
      endpoints: ["/fees", "/relay", "/status/:txHash", "/cctp/delivered", "/health", "/metrics"],
    });
  });

  app.get("/fees", getLimit("/fees"), async (req, res) => {
    const chainId = req.query.chainId === undefined ? deps.hubChainId : Number(req.query.chainId);
    if (!deps.configuredChainIds.includes(chainId)) {
      res.status(404).json({ error: { code: "INVALID_CHAIN", message: "unknown chain" } });
      return;
    }
    res.json(await deps.feeCalculator.getSchedule(chainId));
  });

  app.post("/relay", relayLimit, async (req, res) => {
    const body = req.body as Partial<RelayRequest>;
    if (
      typeof body?.chainId !== "number" ||
      typeof body?.to !== "string" ||
      typeof body?.data !== "string" ||
      typeof body?.feesCacheId !== "string" ||
      (body.idempotencyKey !== undefined &&
        (typeof body.idempotencyKey !== "string" ||
          body.idempotencyKey.length === 0 ||
          body.idempotencyKey.length > IDEMPOTENCY_KEY_MAX))
    ) {
      res.status(400).json({ error: { code: "INVALID_DATA", message: "malformed RelayRequest" } });
      return;
    }

    if (body.idempotencyKey) {
      const existing = await deps.idempotency.get(body.idempotencyKey);
      if (existing) {
        deps.counters.idempotentReplay += 1;
        deps.metrics.idempotentReplay();
        res.json({ txHash: existing.txHash, status: existing.status });
        return;
      }
    }

    try {
      const result = await deps.relay.relay(body as RelayRequest);
      deps.counters.submitSuccess += 1;
      if (body.idempotencyKey) {
        await deps.idempotency.put({
          key: body.idempotencyKey,
          txHash: result.txHash,
          status: "pending",
          chainId: body.chainId,
          createdAt: now(),
          updatedAt: now(),
        });
      }
      res.json(result);
    } catch (err) {
      deps.counters.submitFail += 1;
      if (err instanceof RelayError) {
        if (err.code === "FEE_INSUFFICIENT" || err.code === "FEE_EXPIRED") {
          deps.counters.feeVerifierRejects += 1;
        }
        res.status(err.status).json({ error: { code: err.code, message: err.message } });
      } else {
        logger.error({ err: (err as Error).message }, "unexpected /relay failure");
        res.status(500).json({ error: { code: "INTERNAL", message: "internal error" } });
      }
    }
  });

  app.get("/status/:txHash", getLimit("/status"), async (req, res) => {
    const txHash = String(req.params.txHash ?? "");
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      res.status(400).json({ error: { code: "INVALID_DATA", message: "malformed tx hash" } });
      return;
    }
    const chainId = req.query.chainId === undefined ? undefined : Number(req.query.chainId);
    if (chainId !== undefined && !deps.configuredChainIds.includes(chainId)) {
      res.status(404).json({ error: { code: "INVALID_CHAIN", message: "unknown chain" } });
      return;
    }
    const result = await deps.txStatus(txHash, chainId);
    if (result.status !== "pending") {
      await deps.idempotency.updateStatusByTxHash(txHash, result.status, now());
    }
    res.json(result);
  });

  // Cursor feed replacing v1's per-message /cctp-status/:messageHash (P2, §16.1) — uniform
  // for every watcher of a corridor; consumers match their own sourceTxHash locally.
  app.get("/cctp/delivered", getLimit("/cctp/delivered"), async (req, res) => {
    const destinationDomain = Number(req.query.destinationDomain);
    if (!Number.isInteger(destinationDomain) || destinationDomain < 0) {
      res.status(400).json({
        error: { code: "INVALID_DATA", message: "destinationDomain is required" },
      });
      return;
    }
    const sinceMs = req.query.sinceMs === undefined ? 0 : Number(req.query.sinceMs);
    if (!Number.isFinite(sinceMs) || sinceMs < 0) {
      res.status(400).json({ error: { code: "INVALID_DATA", message: "invalid sinceMs" } });
      return;
    }
    const limit = Math.min(
      req.query.limit === undefined ? 200 : Math.max(1, Number(req.query.limit) || 200),
      200,
    );
    const records = await deps.jobs.delivered(destinationDomain, sinceMs, limit);
    res.json({ records, generatedAt: now().toISOString() });
  });

  app.get("/health", getLimit("/health"), async (_req, res) => {
    const chains = await deps.chainHealth();
    const counts = await deps.jobs.countsByState();
    let pendingCount = 0;
    let deadLetterCount = 0;
    for (const [key, n] of counts) {
      const state = key.split(":")[0]!;
      if (["detected", "awaiting_attestation", "attested", "submitted"].includes(state)) {
        pendingCount += n;
      } else if (state === "dead_letter") {
        deadLetterCount += n;
      }
    }
    const overall = rollup(chains);
    res.status(healthHttpStatus(overall)).json({
      status: overall,
      chains,
      pendingCount,
      deadLetterCount,
      counters: { ...deps.counters },
      generatedAt: now().toISOString(),
    });
  });

  // SHOULD be bound to the internal network / not exposed via the public proxy (§9.1).
  app.get("/metrics", async (_req, res) => {
    res.setHeader("content-type", deps.metrics.registry.contentType);
    res.send(await deps.metrics.registry.metrics());
  });

  return app;
}
