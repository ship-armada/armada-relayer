// ABOUTME: Actor HTTP API — v1-parity public surface (flat {error, code} bodies, exact v1
// ABOUTME: response shapes from http-api.ts) plus the new /cctp/delivered cursor feed (P2).
import express, { type Express } from "express";
import type { FeeCalculator } from "../relay/fee-calculator.js";
import type { PrivacyRelay, RelayRequest } from "../relay/privacy-relay.js";
import type { IdempotencyRepo } from "../db/idempotency-repo.js";
import type { JobsRepo } from "../db/jobs-repo.js";
import { RelayError } from "./errors.js";
import { TokenBucketLimiter, rateLimitMiddleware } from "./rate-limiter.js";
import type { ChainHealthReport } from "./health.js";
import { Counters, healthHttpStatus, rollup } from "./health.js";
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
  counters: Counters;
  metrics: ActorMetrics;
  trustProxy: boolean;
  bodyLimitBytes: number;
  relayRatePerMin: number;
  getRatePerMin: number;
  now?: () => Date;
}

const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

export function createApp(deps: HttpDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  if (deps.trustProxy) app.set("trust proxy", true);
  app.use(express.json({ limit: deps.bodyLimitBytes })); // 256 KiB default (S2)
  const now = deps.now ?? (() => new Date());

  // CORS: public API, no cookies/auth (P3) — v1 uses cors() unrestricted.
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
    deps.counters.inc("rateLimited");
    deps.metrics.rateLimited(endpoint);
  };
  const relayLimit = rateLimitMiddleware(relayLimiter, "/relay", deps.trustProxy, onLimited);
  const getLimit = (endpoint: string) =>
    rateLimitMiddleware(getLimiter, endpoint, deps.trustProxy, onLimited);

  // v1: `/` and `/health` are NOT rate-limited.
  app.get("/", (_req, res) => {
    res.json({
      service: "armada-actor",
      status: "running",
      endpoints: [
        "GET /fees",
        "POST /relay",
        "GET /status/:txHash",
        "GET /cctp/delivered",
        "GET /health",
      ],
    });
  });

  app.get("/fees", getLimit("/fees"), async (req, res) => {
    const chainId = req.query.chainId === undefined ? deps.hubChainId : Number(req.query.chainId);
    if (!Number.isInteger(chainId) || !deps.configuredChainIds.includes(chainId)) {
      res.status(404).json({
        error: `No fee schedule for chain ${chainId}`,
        supported: deps.configuredChainIds,
      });
      return;
    }
    try {
      res.json(await deps.feeCalculator.getSchedule(chainId));
    } catch (err) {
      logger.error({ err: (err as Error).message }, "fee calculation failed");
      res.status(500).json({ error: "Failed to calculate fees" });
    }
  });

  app.post("/relay", relayLimit, async (req, res) => {
    const body = req.body as Partial<RelayRequest>;
    if (
      typeof body?.chainId !== "number" ||
      typeof body?.to !== "string" ||
      typeof body?.data !== "string" ||
      typeof body?.feesCacheId !== "string"
    ) {
      res.status(400).json({ error: "Missing required fields: chainId, to, data, feesCacheId" });
      return;
    }
    if (
      body.idempotencyKey !== undefined &&
      (typeof body.idempotencyKey !== "string" ||
        body.idempotencyKey.length === 0 ||
        body.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH)
    ) {
      res.status(400).json({ error: "Invalid idempotencyKey", code: "INVALID_DATA" });
      return;
    }

    if (body.idempotencyKey) {
      const existing = await deps.idempotency.get(body.idempotencyKey);
      if (existing) {
        deps.counters.inc("idempotentReplay");
        deps.metrics.idempotentReplay();
        res.json({ txHash: existing.txHash, status: existing.status });
        return;
      }
    }

    try {
      const result = await deps.relay.relay(body as RelayRequest);
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
      if (err instanceof RelayError) {
        // v1 error body shape: flat { error: <message>, code: <CODE> }. Counters are
        // incremented inside PrivacyRelay at v1's exact sites (verifier + submit steps).
        res.status(err.status).json({ error: err.message, code: err.code });
      } else {
        logger.error({ err: (err as Error).message }, "unexpected /relay failure");
        res.status(500).json({ error: "Internal relay error", code: "UNKNOWN_ERROR" });
      }
    }
  });

  app.get("/status/:txHash", getLimit("/status"), async (req, res) => {
    const txHash = String(req.params.txHash ?? "");
    if (!txHash.startsWith("0x") || txHash.length !== 66) {
      res.status(400).json({ error: "Invalid transaction hash" });
      return;
    }
    let chainId: number | undefined;
    if (req.query.chainId !== undefined) {
      chainId = Number(req.query.chainId);
      if (!Number.isInteger(chainId) || !deps.configuredChainIds.includes(chainId)) {
        res.status(400).json({ error: `Invalid chainId: ${String(req.query.chainId)}` });
        return;
      }
    }
    const result = await deps.txStatus(txHash, chainId);
    if (result.status !== "pending") {
      // Backfill terminal idempotency status — fire-and-forget (v1 behavior).
      void deps.idempotency
        .updateStatusByTxHash(txHash, result.status, now())
        .catch(() => {});
    }
    res.json(result);
  });

  // Cursor feed replacing v1's per-message /cctp-status/:messageHash (P2, §16.1) — uniform
  // for every watcher of a corridor; consumers match their own sourceTxHash locally.
  app.get("/cctp/delivered", getLimit("/cctp/delivered"), async (req, res) => {
    const destinationDomain = Number(req.query.destinationDomain);
    if (!Number.isInteger(destinationDomain) || destinationDomain < 0) {
      res.status(400).json({ error: "destinationDomain is required", code: "INVALID_DATA" });
      return;
    }
    const sinceMs = req.query.sinceMs === undefined ? 0 : Number(req.query.sinceMs);
    if (!Number.isFinite(sinceMs) || sinceMs < 0) {
      res.status(400).json({ error: "Invalid sinceMs", code: "INVALID_DATA" });
      return;
    }
    const limit = Math.min(
      req.query.limit === undefined ? 200 : Math.max(1, Number(req.query.limit) || 200),
      200,
    );
    const records = await deps.jobs.delivered(destinationDomain, sinceMs, limit);
    res.json({ records, generatedAt: now().getTime() });
  });

  // NOT rate-limited (v1). 200 for healthy|degraded, 503 otherwise, same body either way.
  app.get("/health", async (_req, res) => {
    try {
      const chains = await deps.chainHealth();
      const overall = rollup(chains);
      res.status(healthHttpStatus(overall)).json({
        status: overall,
        chains,
        generatedAt: now().getTime(),
        counters: deps.counters.snapshot(),
      });
    } catch (err) {
      logger.error({ err: (err as Error).message }, "health check failed");
      res.status(503).json({
        status: "unhealthy",
        chains: [],
        generatedAt: now().getTime(),
        counters: deps.counters.snapshot(),
      });
    }
  });

  // SHOULD be bound to the internal network / not exposed via the public proxy (§9.1).
  app.get("/metrics", async (_req, res) => {
    res.setHeader("content-type", deps.metrics.registry.contentType);
    res.send(await deps.metrics.registry.metrics());
  });

  return app;
}
