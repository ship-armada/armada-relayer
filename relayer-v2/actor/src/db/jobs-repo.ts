// ABOUTME: Repository for actor.cctp_jobs — guarded state transitions (§8.4) implemented as
// ABOUTME: single-row transactional updates; Postgres impl for prod, in-memory impl for tests.
import type { DbPool } from "./pool.js";
import type { CctpJob, JobState } from "./types.js";

/** Fields a transition may set alongside the state change. */
export interface JobPatch {
  state?: JobState;
  pollAttempts?: number;
  lastIrisStatus?: string | null;
  attestation?: string | null;
  retryAttempts?: number;
  nextRetryAt?: Date | null;
  submittedTxHash?: string | null;
  submittedAt?: Date | null;
  deliveredTxHash?: string | null;
  deliveredBlock?: bigint | null;
  deliveredAt?: Date | null;
  deadLetterReason?: string | null;
}

export interface DeliveredRecord {
  dedupKey: string;
  sourceDomain: number;
  destinationDomain: number;
  nonce: string;
  sourceTxHash: string;
  destinationTxHash: string;
  destinationBlock: string;
  deliveredAt: number; // epoch ms
}

export interface JobsRepo {
  /** Claims a message by inserting its job row; returns false if already claimed (§8.3). */
  insertIfAbsent(job: CctpJob): Promise<boolean>;
  get(dedupKey: string): Promise<CctpJob | null>;
  listByState(state: JobState, limit: number): Promise<CctpJob[]>;
  /**
   * Guarded transition: applies patch iff the row is still in fromState.
   * Returns true when the row was updated (§8.4 single-row transactional updates).
   */
  transition(dedupKey: string, fromState: JobState, patch: JobPatch, now: Date): Promise<boolean>;
  countsByState(): Promise<Map<string, number>>; // key `${state}:${destinationDomain}`
  delivered(destinationDomain: number, sinceMs: number, limit: number): Promise<DeliveredRecord[]>;
  /** Highest source_block claimed for a source chain domain — fallback scanner cursor aid (§8.7). */
  maxSourceBlock(sourceDomain: number): Promise<bigint | null>;
}

const COLUMN_OF: Record<keyof JobPatch, string> = {
  state: "state",
  pollAttempts: "poll_attempts",
  lastIrisStatus: "last_iris_status",
  attestation: "attestation",
  retryAttempts: "retry_attempts",
  nextRetryAt: "next_retry_at",
  submittedTxHash: "submitted_tx_hash",
  submittedAt: "submitted_at",
  deliveredTxHash: "delivered_tx_hash",
  deliveredBlock: "delivered_block",
  deliveredAt: "delivered_at",
  deadLetterReason: "dead_letter_reason",
};

function rowToJob(r: Record<string, unknown>): CctpJob {
  return {
    dedupKey: r.dedup_key as string,
    messageHash: r.message_hash as string,
    messageBytes: r.message_bytes as string,
    sourceDomain: r.source_domain as number,
    destinationDomain: r.destination_domain as number,
    nonce: r.nonce as string,
    sourceTxHash: r.source_tx_hash as string,
    sourceBlock: BigInt(r.source_block as string),
    state: r.state as JobState,
    detectedAt: r.detected_at as Date,
    pollAttempts: r.poll_attempts as number,
    lastIrisStatus: (r.last_iris_status as string) ?? null,
    attestation: (r.attestation as string) ?? null,
    retryAttempts: r.retry_attempts as number,
    nextRetryAt: (r.next_retry_at as Date) ?? null,
    submittedTxHash: (r.submitted_tx_hash as string) ?? null,
    submittedAt: (r.submitted_at as Date) ?? null,
    deliveredTxHash: (r.delivered_tx_hash as string) ?? null,
    deliveredBlock: r.delivered_block == null ? null : BigInt(r.delivered_block as string),
    deliveredAt: (r.delivered_at as Date) ?? null,
    deadLetterReason: (r.dead_letter_reason as string) ?? null,
    updatedAt: r.updated_at as Date,
  };
}

export class PgJobsRepo implements JobsRepo {
  constructor(private readonly pool: DbPool) {}

  async insertIfAbsent(job: CctpJob): Promise<boolean> {
    const res = await this.pool.query(
      `INSERT INTO actor.cctp_jobs (
         dedup_key, message_hash, message_bytes, source_domain, destination_domain, nonce,
         source_tx_hash, source_block, state, detected_at, poll_attempts, last_iris_status,
         attestation, retry_attempts, next_retry_at, submitted_tx_hash, submitted_at,
         delivered_tx_hash, delivered_block, delivered_at, dead_letter_reason, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       ON CONFLICT (dedup_key) DO NOTHING`,
      [
        job.dedupKey, job.messageHash, job.messageBytes, job.sourceDomain, job.destinationDomain,
        job.nonce, job.sourceTxHash, job.sourceBlock.toString(), job.state, job.detectedAt,
        job.pollAttempts, job.lastIrisStatus, job.attestation, job.retryAttempts, job.nextRetryAt,
        job.submittedTxHash, job.submittedAt, job.deliveredTxHash,
        job.deliveredBlock === null ? null : job.deliveredBlock.toString(),
        job.deliveredAt, job.deadLetterReason, job.updatedAt,
      ],
    );
    return res.rowCount === 1;
  }

  async get(dedupKey: string): Promise<CctpJob | null> {
    const res = await this.pool.query(`SELECT * FROM actor.cctp_jobs WHERE dedup_key = $1`, [
      dedupKey,
    ]);
    return res.rows[0] ? rowToJob(res.rows[0]) : null;
  }

  async listByState(state: JobState, limit: number): Promise<CctpJob[]> {
    const res = await this.pool.query(
      `SELECT * FROM actor.cctp_jobs WHERE state = $1 ORDER BY detected_at ASC LIMIT $2`,
      [state, limit],
    );
    return res.rows.map(rowToJob);
  }

  async transition(
    dedupKey: string,
    fromState: JobState,
    patch: JobPatch,
    now: Date,
  ): Promise<boolean> {
    const sets: string[] = ["updated_at = $3"];
    const values: unknown[] = [dedupKey, fromState, now];
    let i = 4;
    for (const [key, value] of Object.entries(patch)) {
      sets.push(`${COLUMN_OF[key as keyof JobPatch]} = $${i}`);
      values.push(typeof value === "bigint" ? value.toString() : value);
      i += 1;
    }
    const res = await this.pool.query(
      `UPDATE actor.cctp_jobs SET ${sets.join(", ")} WHERE dedup_key = $1 AND state = $2`,
      values,
    );
    return res.rowCount === 1;
  }

  async countsByState(): Promise<Map<string, number>> {
    const res = await this.pool.query(
      `SELECT state, destination_domain, count(*)::int AS n
       FROM actor.cctp_jobs GROUP BY state, destination_domain`,
    );
    const map = new Map<string, number>();
    for (const row of res.rows) map.set(`${row.state}:${row.destination_domain}`, row.n);
    return map;
  }

  async delivered(
    destinationDomain: number,
    sinceMs: number,
    limit: number,
  ): Promise<DeliveredRecord[]> {
    const res = await this.pool.query(
      `SELECT dedup_key, source_domain, destination_domain, nonce, source_tx_hash,
              delivered_tx_hash, delivered_block, delivered_at
       FROM actor.cctp_jobs
       WHERE state = 'delivered' AND destination_domain = $1 AND delivered_at > $2
       ORDER BY delivered_at ASC LIMIT $3`,
      [destinationDomain, new Date(sinceMs), limit],
    );
    return res.rows.map((r) => ({
      dedupKey: r.dedup_key,
      sourceDomain: r.source_domain,
      destinationDomain: r.destination_domain,
      nonce: r.nonce,
      sourceTxHash: r.source_tx_hash,
      destinationTxHash: r.delivered_tx_hash,
      destinationBlock: String(r.delivered_block),
      deliveredAt: (r.delivered_at as Date).getTime(),
    }));
  }

  async maxSourceBlock(sourceDomain: number): Promise<bigint | null> {
    const res = await this.pool.query(
      `SELECT max(source_block) AS m FROM actor.cctp_jobs WHERE source_domain = $1`,
      [sourceDomain],
    );
    return res.rows[0]?.m == null ? null : BigInt(res.rows[0].m);
  }
}

/** In-memory JobsRepo for unit tests — same guarded-transition semantics. */
export class InMemoryJobsRepo implements JobsRepo {
  readonly jobs = new Map<string, CctpJob>();

  async insertIfAbsent(job: CctpJob): Promise<boolean> {
    if (this.jobs.has(job.dedupKey)) return false;
    this.jobs.set(job.dedupKey, { ...job });
    return true;
  }

  async get(dedupKey: string): Promise<CctpJob | null> {
    const j = this.jobs.get(dedupKey);
    return j ? { ...j } : null;
  }

  async listByState(state: JobState, limit: number): Promise<CctpJob[]> {
    return [...this.jobs.values()]
      .filter((j) => j.state === state)
      .sort((a, b) => a.detectedAt.getTime() - b.detectedAt.getTime())
      .slice(0, limit)
      .map((j) => ({ ...j }));
  }

  async transition(
    dedupKey: string,
    fromState: JobState,
    patch: JobPatch,
    now: Date,
  ): Promise<boolean> {
    const job = this.jobs.get(dedupKey);
    if (!job || job.state !== fromState) return false;
    Object.assign(job, patch, { updatedAt: now });
    return true;
  }

  async countsByState(): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    for (const j of this.jobs.values()) {
      const key = `${j.state}:${j.destinationDomain}`;
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }

  async delivered(
    destinationDomain: number,
    sinceMs: number,
    limit: number,
  ): Promise<DeliveredRecord[]> {
    return [...this.jobs.values()]
      .filter(
        (j) =>
          j.state === "delivered" &&
          j.destinationDomain === destinationDomain &&
          j.deliveredAt !== null &&
          j.deliveredAt.getTime() > sinceMs,
      )
      .sort((a, b) => a.deliveredAt!.getTime() - b.deliveredAt!.getTime())
      .slice(0, limit)
      .map((j) => ({
        dedupKey: j.dedupKey,
        sourceDomain: j.sourceDomain,
        destinationDomain: j.destinationDomain,
        nonce: j.nonce,
        sourceTxHash: j.sourceTxHash,
        destinationTxHash: j.deliveredTxHash!,
        destinationBlock: String(j.deliveredBlock),
        deliveredAt: j.deliveredAt!.getTime(),
      }));
  }

  async maxSourceBlock(sourceDomain: number): Promise<bigint | null> {
    let max: bigint | null = null;
    for (const j of this.jobs.values()) {
      if (j.sourceDomain === sourceDomain && (max === null || j.sourceBlock > max)) {
        max = j.sourceBlock;
      }
    }
    return max;
  }
}
