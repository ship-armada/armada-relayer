// ABOUTME: Read-only access to the watcher's published indexed views (§5, D3): work-discovery
// ABOUTME: query (§8.3), MessageReceived dedup lookahead, and watcher indexing progress (§6.6).
import type { DbPool } from "./pool.js";
import type { IndexedMessageSent, WatcherChainProgress } from "./types.js";

export interface IndexedReader {
  /**
   * Messages with no job row yet, confirmation-gated per source chain (§8.3):
   * block_number <= lastIndexedBlock(chain) - confirmations(chain). Zero RPC calls.
   */
  unclaimedMessages(
    confirmationGate: Map<number, bigint>, // chainId -> max eligible block
    limit: number,
  ): Promise<IndexedMessageSent[]>;
  /** True if a MessageReceived row exists for the (sourceDomain, nonce) pair (§8.3 lookahead). */
  messageReceivedExists(sourceDomain: number, nonce: string): Promise<boolean>;
  /** Watcher indexing progress per chain, from Ponder's published status table (§6.6). */
  watcherProgress(): Promise<WatcherChainProgress[]>;
}

export class PgIndexedReader implements IndexedReader {
  constructor(
    private readonly pool: DbPool,
    private readonly schema: string,
  ) {}

  async unclaimedMessages(
    confirmationGate: Map<number, bigint>,
    limit: number,
  ): Promise<IndexedMessageSent[]> {
    if (confirmationGate.size === 0) return [];
    // Per-chain gate expressed as (chain_id, max_block) VALUES join.
    const gates = [...confirmationGate.entries()];
    const values = gates
      .map((_, i) => `($${i * 2 + 1}::int, $${i * 2 + 2}::bigint)`)
      .join(", ");
    const params: unknown[] = gates.flatMap(([chainId, maxBlock]) => [
      chainId,
      maxBlock.toString(),
    ]);
    params.push(limit);
    const res = await this.pool.query(
      `SELECT s.* FROM "${this.schema}".cctp_message_sent s
       JOIN (VALUES ${values}) AS gate(chain_id, max_block) ON gate.chain_id = s.chain_id
       LEFT JOIN actor.cctp_jobs j ON j.dedup_key = s.id
       WHERE j.dedup_key IS NULL AND s.block_number <= gate.max_block
       ORDER BY s.block_number ASC
       LIMIT $${params.length}`,
      params,
    );
    return res.rows.map((r) => ({
      id: r.id,
      chainId: Number(r.chain_id),
      sourceDomain: Number(r.source_domain),
      destinationDomain: Number(r.destination_domain),
      messageBytes: r.message_bytes,
      messageHash: r.message_hash,
      sourceTxHash: r.source_tx_hash,
      logIndex: Number(r.log_index),
      blockNumber: BigInt(r.block_number),
      blockTimestamp: BigInt(r.block_timestamp),
    }));
  }

  async messageReceivedExists(sourceDomain: number, nonce: string): Promise<boolean> {
    const res = await this.pool.query(
      `SELECT 1 FROM "${this.schema}".cctp_message_received
       WHERE source_domain = $1 AND nonce = $2 LIMIT 1`,
      [sourceDomain, nonce],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async watcherProgress(): Promise<WatcherChainProgress[]> {
    // Ponder (pinned 0.16.8, verified against its source) publishes per-chain progress as
    // the _ponder_checkpoint view in the views schema: (chain_name, chain_id,
    // safe_checkpoint, latest_checkpoint, finalized_checkpoint). Checkpoints are
    // fixed-width strings decoded by decodePonderCheckpoint below.
    let rows: Record<string, unknown>[];
    try {
      const res = await this.pool.query(
        `SELECT chain_id, latest_checkpoint FROM "${this.schema}"."_ponder_checkpoint"`,
      );
      rows = res.rows;
    } catch {
      return []; // no checkpoint view => watcher never ran => callers treat as unhealthy
    }
    const progress: WatcherChainProgress[] = [];
    for (const r of rows) {
      if (r.chain_id == null || typeof r.latest_checkpoint !== "string") continue;
      const decoded = decodePonderCheckpoint(r.latest_checkpoint);
      if (!decoded) continue;
      progress.push({
        chainId: Number(r.chain_id),
        lastIndexedBlock: decoded.blockNumber,
        lastIndexedBlockTimestamp: new Date(Number(decoded.blockTimestamp) * 1000),
        ready: true,
      });
    }
    return progress;
  }
}

/** Decodes Ponder's fixed-width checkpoint string: 10-digit unix blockTimestamp,
 * 16-digit chainId, 16-digit blockNumber (remaining fields unused here). */
export function decodePonderCheckpoint(
  checkpoint: string,
): { blockTimestamp: bigint; chainId: bigint; blockNumber: bigint } | null {
  if (!/^\d{75}$/.test(checkpoint)) return null;
  return {
    blockTimestamp: BigInt(checkpoint.slice(0, 10)),
    chainId: BigInt(checkpoint.slice(10, 26)),
    blockNumber: BigInt(checkpoint.slice(26, 42)),
  };
}

/** In-memory IndexedReader for unit tests. */
export class InMemoryIndexedReader implements IndexedReader {
  messages: IndexedMessageSent[] = [];
  received = new Set<string>(); // `${sourceDomain}:${nonce}`
  progress: WatcherChainProgress[] = [];
  claimed: (id: string) => Promise<boolean> = async () => false;

  async unclaimedMessages(
    confirmationGate: Map<number, bigint>,
    limit: number,
  ): Promise<IndexedMessageSent[]> {
    const out: IndexedMessageSent[] = [];
    for (const m of [...this.messages].sort((a, b) => Number(a.blockNumber - b.blockNumber))) {
      const gate = confirmationGate.get(m.chainId);
      if (gate === undefined || m.blockNumber > gate) continue;
      if (await this.claimed(m.id)) continue;
      out.push({ ...m });
      if (out.length >= limit) break;
    }
    return out;
  }

  async messageReceivedExists(sourceDomain: number, nonce: string): Promise<boolean> {
    return this.received.has(`${sourceDomain}:${nonce}`);
  }

  async watcherProgress(): Promise<WatcherChainProgress[]> {
    return this.progress.map((p) => ({ ...p }));
  }
}
