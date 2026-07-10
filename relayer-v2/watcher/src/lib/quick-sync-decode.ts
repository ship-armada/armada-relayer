// ABOUTME: Decodes stored raw Hub logs into the engine's AccumulatedEvents element shapes
// ABOUTME: (spec §7.3). Phase 2: nullifiers + unshields. Byte encodings match engine 9.5.1.
import { decodeEventLog } from "viem";
import { PrivacyPoolAbi } from "../../abis/PrivacyPool";
import type { QuickSyncNullifier, QuickSyncUnshieldEvent } from "../api/quick-sync";

/** A stored raw log row (from the `raw_event_log` table), ordered by (blockNumber, logIndex). */
export interface RawLogRow {
  blockNumber: bigint;
  txHash: string;
  logIndex: number;
  data: string; // 0x…
  topics: string[]; // decoded from the stored JSON array
}

/**
 * UINT_256 formatting matching the engine's `ByteUtils.formatToByteLength(x, UINT_256)` /
 * `nToHex(x, UINT_256)`: 32-byte (64-char) unprefixed lowercase hex, left-zero-padded.
 * txids, commitment hashes, and nullifiers are all emitted this way.
 */
export function formatUint256(hex: string): string {
  const body = (hex.startsWith("0x") ? hex.slice(2) : hex).toLowerCase();
  if (body.length > 64) return body.slice(body.length - 64); // defensive; should not exceed
  return body.padStart(64, "0");
}

function decode(row: RawLogRow) {
  return decodeEventLog({
    abi: PrivacyPoolAbi,
    data: row.data as `0x${string}`,
    topics: row.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
  });
}

/** Nullified → one Nullifier per array element, in event array order (engine scan order). */
export function decodeNullifiers(rows: RawLogRow[]): QuickSyncNullifier[] {
  const out: QuickSyncNullifier[] = [];
  for (const row of rows) {
    const ev = decode(row);
    if (ev.eventName !== "Nullified") continue;
    const args = ev.args as { treeNumber: number | bigint; nullifier: readonly string[] };
    for (const n of args.nullifier) {
      out.push({
        nullifier: formatUint256(n),
        treeNumber: Number(args.treeNumber),
        txid: formatUint256(row.txHash),
        blockNumber: Number(row.blockNumber),
      });
    }
  }
  return out;
}

/** Unshield → UnshieldStoredEvent; eventLogIndex from the stored logIndex (engine scan path). */
export function decodeUnshields(rows: RawLogRow[]): QuickSyncUnshieldEvent[] {
  const out: QuickSyncUnshieldEvent[] = [];
  for (const row of rows) {
    const ev = decode(row);
    if (ev.eventName !== "Unshield") continue;
    const args = ev.args as {
      to: string;
      token: { tokenType: number | bigint; tokenAddress: string; tokenSubID: bigint };
      amount: bigint;
      fee: bigint;
    };
    out.push({
      txid: formatUint256(row.txHash),
      timestamp: undefined,
      toAddress: args.to,
      tokenType: Number(args.token.tokenType),
      tokenAddress: args.token.tokenAddress,
      tokenSubID: args.token.tokenSubID.toString(),
      amount: args.amount.toString(),
      fee: args.fee.toString(),
      blockNumber: Number(row.blockNumber),
      eventLogIndex: row.logIndex,
      railgunTxid: undefined,
      poisPerList: undefined,
    });
  }
  return out;
}
