// ABOUTME: Durable POST /relay idempotency store in actor.idempotency (§5.2, §6.3) —
// ABOUTME: first call executes, repeats return the recorded result; terminal status backfilled.
import type { DbPool } from "./pool.js";

export type IdempotencyStatus = "pending" | "confirmed" | "failed";

export interface IdempotencyRecord {
  key: string;
  txHash: string;
  status: IdempotencyStatus;
  chainId: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface IdempotencyRepo {
  get(key: string): Promise<IdempotencyRecord | null>;
  put(record: IdempotencyRecord): Promise<void>;
  updateStatus(key: string, status: IdempotencyStatus, now: Date): Promise<void>;
  /** Backfills terminal status when a /status/:txHash lookup resolves (§6.3). */
  updateStatusByTxHash(txHash: string, status: IdempotencyStatus, now: Date): Promise<void>;
}

export class PgIdempotencyRepo implements IdempotencyRepo {
  constructor(private readonly pool: DbPool) {}

  async get(key: string): Promise<IdempotencyRecord | null> {
    const res = await this.pool.query(`SELECT * FROM actor.idempotency WHERE key = $1`, [key]);
    const r = res.rows[0];
    if (!r) return null;
    return {
      key: r.key,
      txHash: r.tx_hash,
      status: r.status,
      chainId: r.chain_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async put(record: IdempotencyRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO actor.idempotency (key, tx_hash, status, chain_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (key) DO NOTHING`,
      [record.key, record.txHash, record.status, record.chainId, record.createdAt, record.updatedAt],
    );
  }

  async updateStatus(key: string, status: IdempotencyStatus, now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE actor.idempotency SET status = $2, updated_at = $3 WHERE key = $1`,
      [key, status, now],
    );
  }

  async updateStatusByTxHash(txHash: string, status: IdempotencyStatus, now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE actor.idempotency SET status = $2, updated_at = $3
       WHERE tx_hash = $1 AND status = 'pending'`,
      [txHash, status, now],
    );
  }
}

/** In-memory IdempotencyRepo for unit tests. */
export class InMemoryIdempotencyRepo implements IdempotencyRepo {
  readonly records = new Map<string, IdempotencyRecord>();

  async get(key: string): Promise<IdempotencyRecord | null> {
    const r = this.records.get(key);
    return r ? { ...r } : null;
  }

  async put(record: IdempotencyRecord): Promise<void> {
    if (!this.records.has(record.key)) this.records.set(record.key, { ...record });
  }

  async updateStatus(key: string, status: IdempotencyStatus, now: Date): Promise<void> {
    const r = this.records.get(key);
    if (r) {
      r.status = status;
      r.updatedAt = now;
    }
  }

  async updateStatusByTxHash(txHash: string, status: IdempotencyStatus, now: Date): Promise<void> {
    for (const r of this.records.values()) {
      if (r.txHash === txHash && r.status === "pending") {
        r.status = status;
        r.updatedAt = now;
      }
    }
  }
}
