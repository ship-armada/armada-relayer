// ABOUTME: Decodes stored raw Hub logs into the engine's AccumulatedEvents element shapes
// ABOUTME: (spec §7.3). Phase 2: nullifiers + unshields. Byte encodings match engine 9.5.1.
import { decodeEventLog } from "viem";
import { PrivacyPoolAbi } from "../../abis/PrivacyPool";
import type {
  QuickSyncNullifier,
  QuickSyncUnshieldEvent,
  QuickSyncCommitmentEvent,
  QuickSyncTransactCommitment,
} from "../api/quick-sync";
import { TRANSACT_COMMITMENT_V2_TYPE } from "../api/quick-sync";

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

/**
 * Transact → one CommitmentEvent per log, each commitment a TransactCommitmentV2. Hashes are
 * GIVEN in the event's `hash[]`. Ciphertext split matches the engine's formatCommitmentCiphertext:
 * ivTag = ciphertext[0] (iv = first 16 bytes, tag = last 16), data = ciphertext[1..3]. Verified
 * against engine 9.5.1 V2Events.formatTransactEvent.
 */
export function decodeTransactCommitments(rows: RawLogRow[]): QuickSyncCommitmentEvent[] {
  const out: QuickSyncCommitmentEvent[] = [];
  for (const row of rows) {
    const ev = decode(row);
    if (ev.eventName !== "Transact") continue;
    const args = ev.args as {
      treeNumber: number | bigint;
      startPosition: number | bigint;
      hash: readonly string[];
      ciphertext: readonly {
        ciphertext: readonly string[]; // bytes32[4]
        blindedSenderViewingKey: string;
        blindedReceiverViewingKey: string;
        annotationData: string;
        memo: string;
      }[];
    };
    const utxoTree = Number(args.treeNumber);
    const startPosition = Number(args.startPosition);
    const txid = formatUint256(row.txHash);
    const commitments: QuickSyncTransactCommitment[] = args.ciphertext.map((cc, i) => {
      const ct = cc.ciphertext.map(formatUint256); // each 64-char UINT_256
      const ivTag = ct[0]!;
      return {
        commitmentType: TRANSACT_COMMITMENT_V2_TYPE,
        hash: formatUint256(args.hash[i]!),
        txid,
        timestamp: undefined,
        blockNumber: Number(row.blockNumber),
        utxoTree,
        utxoIndex: startPosition + i,
        railgunTxid: undefined,
        ciphertext: {
          ciphertext: {
            iv: ivTag.substring(0, 32), // first 16 bytes
            tag: ivTag.substring(32), // last 16 bytes
            data: ct.slice(1), // remaining bytes32 elements
          },
          blindedSenderViewingKey: formatUint256(cc.blindedSenderViewingKey),
          blindedReceiverViewingKey: formatUint256(cc.blindedReceiverViewingKey),
          annotationData: cc.annotationData, // bytes — passed through as decoded
          memo: cc.memo,
        },
      };
    });
    out.push({ txid, treeNumber: utxoTree, startPosition, commitments, blockNumber: Number(row.blockNumber) });
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
