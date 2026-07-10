// ABOUTME: M3 cutover import (spec §14): loads v1 relayer/state/pending-*.json into
// ABOUTME: actor.cctp_jobs so the actor never re-relays v1's recent deliveries.
// Usage: DATABASE_URL=... npx tsx scripts/import-v1-state.ts <path-to-v1-state-dir>
//
// DEF-4 (.context/deviations.md): the exact v1 file shape was unavailable in this
// workspace; the parser below tolerantly accepts the shape described in the spec —
// a `processed` collection of dedup keys plus in-flight pending message entries.
// Verify against real v1 state files before running M3. The destination contract's
// replay protection backstops any import gap (a re-relay attempt reverts).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createPool } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { PgJobsRepo } from "../src/db/jobs-repo.js";
import type { CctpJob } from "../src/db/types.js";

const ZERO32 = "0x" + "00".repeat(32);

function baseJob(dedupKey: string, state: CctpJob["state"], now: Date): CctpJob {
  const [sourceTxHash] = dedupKey.split(":");
  return {
    dedupKey,
    messageHash: "",
    messageBytes: "0x",
    sourceDomain: -1, // unknown from v1 processed-keys (spec §14: null-ish dest fields)
    destinationDomain: -1,
    nonce: ZERO32,
    sourceTxHash: sourceTxHash ?? "",
    sourceBlock: 0n,
    state,
    detectedAt: now,
    pollAttempts: 0,
    lastIrisStatus: "imported_from_v1",
    attestation: null,
    retryAttempts: 0,
    nextRetryAt: null,
    submittedTxHash: null,
    submittedAt: null,
    deliveredTxHash: null,
    deliveredBlock: null,
    deliveredAt: state === "delivered" ? now : null,
    deadLetterReason: null,
    updatedAt: now,
  };
}

interface V1Pending {
  dedupKey?: string;
  messageHash?: string;
  messageBytes?: string;
  message?: string;
  sourceDomain?: number;
  destinationDomain?: number;
  sourceTxHash?: string;
  sourceBlock?: number;
  attestation?: string;
  submittedTxHash?: string;
  txHash?: string;
}

async function main(): Promise<void> {
  const stateDir = process.argv[2];
  const databaseUrl = process.env.DATABASE_URL;
  if (!stateDir || !databaseUrl) {
    console.error("usage: DATABASE_URL=... npx tsx scripts/import-v1-state.ts <v1-state-dir>");
    process.exit(1);
  }
  const pool = createPool(databaseUrl);
  await migrate(databaseUrl);
  const jobs = new PgJobsRepo(pool);
  const now = new Date();
  let imported = 0;
  let skipped = 0;

  for (const file of readdirSync(stateDir).filter((f) => /^pending-.*\.json$/.test(f))) {
    const raw = JSON.parse(readFileSync(join(stateDir, file), "utf8"));

    // processed dedup keys -> delivered (null destination fields where unknown)
    const processed: string[] = Array.isArray(raw.processed)
      ? raw.processed
      : raw.processed && typeof raw.processed === "object"
        ? Object.keys(raw.processed)
        : [];
    for (const dedupKey of processed) {
      (await jobs.insertIfAbsent(baseJob(dedupKey, "delivered", now))) ? imported++ : skipped++;
    }

    // in-flight pending messages -> attested (with bytes) or submitted (with tx hash)
    const pending: V1Pending[] = Array.isArray(raw.pending)
      ? raw.pending
      : raw.pending && typeof raw.pending === "object"
        ? Object.values(raw.pending)
        : [];
    for (const p of pending) {
      const dedupKey = p.dedupKey ?? (p.sourceTxHash ? `${p.sourceTxHash}:0` : null);
      if (!dedupKey) {
        console.warn(`WARN ${file}: pending entry without dedupKey skipped`);
        skipped++;
        continue;
      }
      const submittedTx = p.submittedTxHash ?? p.txHash ?? null;
      const job = baseJob(dedupKey, submittedTx ? "submitted" : "attested", now);
      job.messageBytes = p.messageBytes ?? p.message ?? "0x";
      job.messageHash = p.messageHash ?? "";
      job.sourceDomain = p.sourceDomain ?? -1;
      job.destinationDomain = p.destinationDomain ?? -1;
      job.sourceBlock = BigInt(p.sourceBlock ?? 0);
      job.attestation = p.attestation ?? null;
      job.submittedTxHash = submittedTx;
      job.submittedAt = submittedTx ? now : null;
      (await jobs.insertIfAbsent(job)) ? imported++ : skipped++;
    }
  }

  console.log(`imported ${imported} jobs, skipped ${skipped} (already present / unparseable)`);
  await pool.end();
}

main().catch((err) => {
  console.error("import failed:", err);
  process.exit(1);
});
