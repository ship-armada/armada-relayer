// ABOUTME: Postgres-backed integration tests (§15.2 subset runnable without chains): migration,
// ABOUTME: job repo guarded transitions, idempotency, and the §8.3 cross-schema discovery query.
// Gated on ACTOR_TEST_PG_URL (CI/dev provides a disposable postgres).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool, type DbPool } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { PgJobsRepo } from "../src/db/jobs-repo.js";
import { PgIdempotencyRepo } from "../src/db/idempotency-repo.js";
import { PgIndexedReader } from "../src/db/indexed-reader.js";
import { mkJob, buildCctpMessage } from "./helpers.js";
import { keccak256 } from "ethers";

const PG_URL = process.env.ACTOR_TEST_PG_URL;

describe.skipIf(!PG_URL)("postgres integration", () => {
  let pool: DbPool;

  beforeAll(async () => {
    pool = createPool(PG_URL!);
    await pool.query("DROP SCHEMA IF EXISTS actor CASCADE");
    await pool.query("DROP SCHEMA IF EXISTS indexed CASCADE");
    await migrate(PG_URL!);
    // Simulate the watcher's published views (§5): minimal indexed schema + checkpoint.
    await pool.query(`CREATE SCHEMA indexed`);
    await pool.query(`
      CREATE TABLE indexed.cctp_message_sent (
        id text PRIMARY KEY, chain_id int, source_domain int, destination_domain int,
        message_bytes text, message_hash text, source_tx_hash text, log_index int,
        block_number bigint, block_timestamp bigint
      )`);
    await pool.query(`
      CREATE TABLE indexed.cctp_message_received (
        id text PRIMARY KEY, chain_id int, source_domain int, nonce text, caller text,
        destination_tx_hash text, block_number bigint
      )`);
    await pool.query(`
      CREATE TABLE indexed."_ponder_checkpoint" (
        chain_name text PRIMARY KEY, chain_id bigint, safe_checkpoint varchar(75),
        latest_checkpoint varchar(75), finalized_checkpoint varchar(75)
      )`);
  }, 30000);

  afterAll(async () => {
    await pool?.end();
  });

  it("migration is idempotent", async () => {
    await migrate(PG_URL!); // second run: no-op, no throw
    const res = await pool.query(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'actor'",
    );
    expect(res.rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it("job repo: insert-once claim, guarded transitions, delivered feed", async () => {
    const jobs = new PgJobsRepo(pool);
    const job = mkJob({ dedupKey: "0xint:1", state: "detected" });
    expect(await jobs.insertIfAbsent(job)).toBe(true);
    expect(await jobs.insertIfAbsent(job)).toBe(false); // claim-once (§8.3)

    // guarded transition: wrong fromState is a no-op
    expect(await jobs.transition("0xint:1", "attested", { state: "submitted" }, new Date())).toBe(
      false,
    );
    expect(
      await jobs.transition(
        "0xint:1",
        "detected",
        { state: "attested", attestation: "0xbeef" },
        new Date(),
      ),
    ).toBe(true);
    const stored = await jobs.get("0xint:1");
    expect(stored!.state).toBe("attested");
    expect(stored!.attestation).toBe("0xbeef");

    await jobs.transition(
      "0xint:1",
      "attested",
      {
        state: "delivered",
        deliveredTxHash: "0xdd",
        deliveredBlock: 42n,
        deliveredAt: new Date(1_750_000_000_000),
      },
      new Date(),
    );
    const delivered = await jobs.delivered(100, 0, 200);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      dedupKey: "0xint:1",
      destinationTxHash: "0xdd",
      destinationBlock: "42",
      deliveredAt: 1_750_000_000_000,
    });

    const counts = await jobs.countsByState();
    expect(counts.get("delivered:100")).toBe(1);
  });

  it("idempotency repo round-trip with tx-hash backfill", async () => {
    const repo = new PgIdempotencyRepo(pool);
    const now = new Date();
    await repo.put({
      key: "k-int",
      txHash: "0xtx",
      status: "pending",
      chainId: 31337,
      createdAt: now,
      updatedAt: now,
    });
    await repo.put({
      key: "k-int",
      txHash: "0xother",
      status: "pending",
      chainId: 31337,
      createdAt: now,
      updatedAt: now,
    }); // first-writer wins
    expect((await repo.get("k-int"))!.txHash).toBe("0xtx");
    await repo.updateStatusByTxHash("0xtx", "confirmed", now);
    expect((await repo.get("k-int"))!.status).toBe("confirmed");
  });

  it("§8.3 discovery query: unclaimed + confirmation-gated, and checkpoint decode", async () => {
    const reader = new PgIndexedReader(pool, "indexed");
    const message = buildCctpMessage();
    await pool.query(
      `INSERT INTO indexed.cctp_message_sent VALUES
       ('0xm1:0', 31338, 101, 100, $1, $2, '0xm1', 0, 100, 1750000000),
       ('0xm2:0', 31338, 101, 100, $1, $2, '0xm2', 0, 999, 1750000000)`,
      [message, keccak256(message)],
    );
    const checkpoint =
      "1750000000" + "0000000000031338" + "0000000000000200" + "0000000000000000" + "5" + "0000000000000000";
    await pool.query(
      `INSERT INTO indexed."_ponder_checkpoint" VALUES ('clientA', 31338, $1, $1, $1)`,
      [checkpoint],
    );

    const progress = await reader.watcherProgress();
    expect(progress).toEqual([
      {
        chainId: 31338,
        lastIndexedBlock: 200n,
        lastIndexedBlockTimestamp: new Date(1_750_000_000_000),
        ready: true,
      },
    ]);

    // gate at block 200: only 0xm1:0 (block 100) is eligible; 0xm2:0 (999) waits
    const unclaimed = await reader.unclaimedMessages(new Map([[31338, 200n]]), 100);
    expect(unclaimed.map((m) => m.id)).toEqual(["0xm1:0"]);

    // claiming removes it from the next discovery round
    const jobs = new PgJobsRepo(pool);
    await jobs.insertIfAbsent(mkJob({ dedupKey: "0xm1:0" }));
    expect(await reader.unclaimedMessages(new Map([[31338, 200n]]), 100)).toEqual([]);

    // received-lookahead
    await pool.query(
      `INSERT INTO indexed.cctp_message_received VALUES ('r1', 31337, 101, '0xabc', '0xc', '0xd', 5)`,
    );
    expect(await reader.messageReceivedExists(101, "0xabc")).toBe(true);
    expect(await reader.messageReceivedExists(101, "0xzzz")).toBe(false);
  });
});
