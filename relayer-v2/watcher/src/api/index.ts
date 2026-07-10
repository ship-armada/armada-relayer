// ABOUTME: Public read API (§7.3) served by the watcher: global event streams with cursor
// ABOUTME: pagination (P1), contract-address-filtered raw logs, and rich health at /v1/health.
import { Hono } from "hono";
import { db, publicClients } from "ponder:api";
import schema from "ponder:schema";
import { and, asc, gte, lte, eq, sql } from "ponder";
import { join } from "node:path";
import { resolveChains, protocolAddressAllowlist } from "../lib/manifests";
import {
  parseRangeParams,
  nextCursorOf,
  cacheControlFor,
  checkpointBlock,
  classifyFreshness,
  worstOf,
} from "../lib/api-helpers";
import { emptyQuickSync } from "./quick-sync";
import {
  decodeNullifiers,
  decodeUnshields,
  decodeTransactCommitments,
  type RawLogRow,
} from "../lib/quick-sync-decode";

const deploymentsRoot =
  process.env.DEPLOYMENTS_DIR ?? join(process.cwd(), "..", "..", "deployments");
const chains = resolveChains(process.env, deploymentsRoot);
const hub = chains.find((c) => c.role === "hub")!;
const allowlist = protocolAddressAllowlist(chains);

const app = new Hono();

// No auth, no cookies, global streams only (P1/P3). CORS * comes from Ponder's server.

interface ChainProgress {
  chainId: number;
  blockNumber: bigint;
  blockTimestamp: bigint;
}

async function watcherProgress(): Promise<ChainProgress[]> {
  // _ponder_checkpoint lives in the deployment schema, which is on the API db's search
  // path (verified against pinned Ponder 0.16.8; see relayer-v2/README.md).
  try {
    const rows = (await db.execute(
      sql`SELECT chain_id, latest_checkpoint FROM "_ponder_checkpoint"`,
    )) as unknown as { rows: { chain_id: string | number; latest_checkpoint: string }[] };
    const out: ChainProgress[] = [];
    for (const row of rows.rows) {
      const decoded = checkpointBlock(row.latest_checkpoint);
      if (!decoded) continue;
      out.push({
        chainId: Number(row.chain_id),
        blockNumber: decoded.number,
        blockTimestamp: decoded.timestamp,
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function indexedThrough(chainId: number): Promise<bigint | null> {
  const progress = await watcherProgress();
  return progress.find((p) => p.chainId === chainId)?.blockNumber ?? null;
}

app.get("/v1/commitments", async (c) => {
  const params = parseRangeParams(c.req.query());
  if ("error" in params) return c.json({ error: params.error }, 400);
  const through = await indexedThrough(hub.chainId);
  const conditions = [gte(schema.commitmentBatch.blockNumber, params.fromBlock)];
  if (params.toBlock !== null) {
    conditions.push(lte(schema.commitmentBatch.blockNumber, params.toBlock));
  }
  const rows = await db
    .select()
    .from(schema.commitmentBatch)
    .where(and(...conditions))
    .orderBy(asc(schema.commitmentBatch.blockNumber), asc(schema.commitmentBatch.logIndex))
    .limit(params.limit);
  const items = rows.map((r) => ({
    blockNumber: Number(r.blockNumber),
    txHash: r.txHash,
    logIndex: r.logIndex,
    data: r.rawData,
    topics: JSON.parse(r.rawTopics) as string[],
  }));
  c.header("cache-control", cacheControlFor(params.toBlock, through, hub.confirmations));
  return c.json({
    items,
    nextCursor: nextCursorOf(rows, params.limit),
    indexedThrough: through === null ? null : Number(through),
  });
});

app.get("/v1/nullifiers", async (c) => {
  const params = parseRangeParams(c.req.query());
  if ("error" in params) return c.json({ error: params.error }, 400);
  const through = await indexedThrough(hub.chainId);
  const conditions = [gte(schema.nullifier.blockNumber, params.fromBlock)];
  if (params.toBlock !== null) {
    conditions.push(lte(schema.nullifier.blockNumber, params.toBlock));
  }
  const rows = await db
    .select()
    .from(schema.nullifier)
    .where(and(...conditions))
    .orderBy(asc(schema.nullifier.blockNumber), asc(schema.nullifier.logIndex))
    .limit(params.limit);
  const items = rows.map((r) => ({
    blockNumber: Number(r.blockNumber),
    txHash: r.txHash,
    logIndex: r.logIndex,
    hash: r.hash,
  }));
  c.header("cache-control", cacheControlFor(params.toBlock, through, hub.confirmations));
  return c.json({
    items,
    nextCursor: nextCursorOf(rows, params.limit),
    indexedThrough: through === null ? null : Number(through),
  });
});

// Quick-sync (§7.3, fast-follow): serves the Railgun engine's AccumulatedEvents for the hub,
// decoded server-side from stored raw logs so a frontend engine hydrates its merkletree from one
// call instead of scanning from block 0. Railgun events live only on the hub. P1/P4 compliant.
// NOTE: nullifiers + unshields decoded (phase 2); commitmentEvents land in phases 3–4
// (transact + poseidon shield hash) — see .context/PLAN_QUICK_SYNC.md.
const HUB_POOL_ADDRESS = hub.manifest.contracts.privacyPool!.toLowerCase();

app.get("/v1/quick-sync/:chainId", async (c) => {
  const chainId = Number(c.req.param("chainId"));
  if (!Number.isInteger(chainId) || chainId !== hub.chainId) {
    return c.json(
      { error: `quick-sync is only served for the hub chain ${hub.chainId} (Railgun events)` },
      400,
    );
  }
  const startingBlockRaw = c.req.query("startingBlock");
  const startingBlock = Number(startingBlockRaw);
  if (startingBlockRaw === undefined || !Number.isInteger(startingBlock) || startingBlock < 0) {
    return c.json({ error: "startingBlock is required and must be a non-negative integer" }, 400);
  }
  const through = await indexedThrough(hub.chainId);

  // All Railgun events (Shield/Transact/Nullified/Unshield) are emitted by the hub pool, so
  // filtering by that address yields only decodable PrivacyPool logs (P1: contract filter only).
  const conditions = [
    eq(schema.rawEventLog.chainId, hub.chainId),
    eq(schema.rawEventLog.address, HUB_POOL_ADDRESS),
    gte(schema.rawEventLog.blockNumber, BigInt(startingBlock)),
  ];
  if (through !== null) conditions.push(lte(schema.rawEventLog.blockNumber, through));
  const dbRows = await db
    .select()
    .from(schema.rawEventLog)
    .where(and(...conditions))
    .orderBy(asc(schema.rawEventLog.blockNumber), asc(schema.rawEventLog.logIndex));
  const rows: RawLogRow[] = dbRows.map((r) => ({
    blockNumber: r.blockNumber,
    txHash: r.txHash,
    logIndex: r.logIndex,
    data: r.data,
    topics: JSON.parse(r.topics) as string[],
  }));

  // commitmentEvents: transact decoded here (phase 3); shield commitments (poseidon hash) added
  // in phase 4. Ordered by (block, logIndex) via the query; shields will merge-sort in.
  const result = {
    ...emptyQuickSync(),
    commitmentEvents: decodeTransactCommitments(rows),
    nullifierEvents: decodeNullifiers(rows),
    unshieldEvents: decodeUnshields(rows),
  };
  c.header("cache-control", cacheControlFor(null, through, hub.confirmations));
  return c.json({ ...result, indexedThrough: through === null ? null : Number(through) });
});

app.get("/v1/logs", async (c) => {
  const chainIdRaw = c.req.query("chainId");
  const address = c.req.query("address");
  if (!chainIdRaw || !/^\d+$/.test(chainIdRaw)) {
    return c.json({ error: "chainId is required" }, 400);
  }
  const chainId = Number(chainIdRaw);
  // Contract-address filter only — never a user filter (P1). Unknown addresses → 400.
  const allowed = allowlist.get(chainId);
  if (!address || !allowed || !allowed.has(address.toLowerCase())) {
    return c.json({ error: "address must be an indexed protocol contract for chainId" }, 400);
  }
  const params = parseRangeParams(c.req.query());
  if ("error" in params) return c.json({ error: params.error }, 400);
  const through = await indexedThrough(chainId);
  const conditions = [
    eq(schema.rawEventLog.chainId, chainId),
    eq(schema.rawEventLog.address, address.toLowerCase()),
    gte(schema.rawEventLog.blockNumber, params.fromBlock),
  ];
  if (params.toBlock !== null) {
    conditions.push(lte(schema.rawEventLog.blockNumber, params.toBlock));
  }
  const rows = await db
    .select()
    .from(schema.rawEventLog)
    .where(and(...conditions))
    .orderBy(asc(schema.rawEventLog.blockNumber), asc(schema.rawEventLog.logIndex))
    .limit(params.limit);
  const chain = chains.find((ch) => ch.chainId === chainId)!;
  const items = rows.map((r) => ({
    blockNumber: Number(r.blockNumber),
    txHash: r.txHash,
    logIndex: r.logIndex,
    address: r.address,
    data: r.data,
    topics: JSON.parse(r.topics) as string[],
  }));
  c.header("cache-control", cacheControlFor(params.toBlock, through, chain.confirmations));
  return c.json({
    items,
    nextCursor: nextCursorOf(rows, params.limit),
    indexedThrough: through === null ? null : Number(through),
  });
});

// Rich health with §6.6 semantics. NOTE (DEV-8): Ponder's built-in GET /health (bare 200)
// shadows this path at the server level, so the full payload lives at /v1/health.
app.get("/v1/health", async (c) => {
  const progress = await watcherProgress();
  const nowMs = Date.now();
  const reports = await Promise.all(
    chains.map(async (chain) => {
      const p = progress.find((x) => x.chainId === chain.chainId);
      let head: bigint | null = null;
      try {
        const client = (publicClients as Record<string, { getBlockNumber(): Promise<bigint> }>)[
          chain.name
        ];
        head = client ? await client.getBlockNumber() : null;
      } catch {
        head = null;
      }
      const lastIndexedBlock = p?.blockNumber ?? null;
      const lagBlocks =
        head !== null && lastIndexedBlock !== null ? Number(head - lastIndexedBlock) : null;
      return {
        chainId: chain.chainId,
        lastIndexedBlock: lastIndexedBlock === null ? null : Number(lastIndexedBlock),
        head: head === null ? null : Number(head),
        lagBlocks,
        lastEventAt: p ? new Date(Number(p.blockTimestamp) * 1000).toISOString() : null,
        status: classifyFreshness(
          nowMs,
          p ? Number(p.blockTimestamp) * 1000 : null,
          chain.pollingIntervalMs,
          lagBlocks,
        ),
      };
    }),
  );
  const status = worstOf(reports.map((r) => r.status));
  return c.json(
    { status, chains: reports, generatedAt: new Date().toISOString() },
    status === "stale" || status === "unhealthy" ? 503 : 200,
  );
});

export default app;
