// ABOUTME: Decodes stored raw Hub logs into the engine's AccumulatedEvents element shapes
// ABOUTME: (spec §7.3). Phase 2: nullifiers + unshields. Byte encodings match engine 9.5.1.
import { decodeEventLog } from "viem";
import { PrivacyPoolAbi } from "../../abis/PrivacyPool";
import type {
  QuickSyncNullifier,
  QuickSyncUnshieldEvent,
  QuickSyncCommitmentEvent,
  QuickSyncTransactCommitment,
  QuickSyncShieldCommitment,
} from "../api/quick-sync";
import { TRANSACT_COMMITMENT_V2_TYPE, SHIELD_COMMITMENT_TYPE } from "../api/quick-sync";
import { poseidonHash } from "./poseidon";

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

// --- engine ByteUtils-equivalent formatters (ERC20 path; verified vs note-util.js) ---

const bi = (hex: string): bigint => BigInt(hex.startsWith("0x") ? hex : `0x${hex}`);
/** nToHex(value, UINT_256, prefix=false) — 64-char unprefixed lowercase. */
const nToHex256 = (n: bigint): string => n.toString(16).padStart(64, "0");
/** serializeTokenData(...).tokenAddress = formatToByteLength(addr, Address=20, prefix=true). */
const serializeTokenAddress = (addr: string): string =>
  "0x" + (addr.startsWith("0x") ? addr.slice(2) : addr).toLowerCase().padStart(40, "0");
/** serializeTokenData(...).tokenSubID = nToHex(BigInt(subID), UINT_256, prefix=true). */
const serializeTokenSubID = (subID: bigint): string => "0x" + subID.toString(16).padStart(64, "0");
/** formatValue(value, prefix=false) = nToHex(value, UINT_128, false) — 32-char unprefixed. */
const formatValue128 = (value: bigint): string => value.toString(16).padStart(32, "0");

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
function transactEventOf(
  row: RawLogRow,
  args: {
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
  },
): QuickSyncCommitmentEvent {
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
  return { txid, treeNumber: utxoTree, startPosition, commitments, blockNumber: Number(row.blockNumber) };
}

export function decodeTransactCommitments(rows: RawLogRow[]): QuickSyncCommitmentEvent[] {
  const out: QuickSyncCommitmentEvent[] = [];
  for (const row of rows) {
    const ev = decode(row);
    if (ev.eventName === "Transact") out.push(transactEventOf(row, ev.args as never));
  }
  return out;
}

/**
 * Shield → one CommitmentEvent per log, each a ShieldCommitment. The hash is COMPUTED (the
 * event carries only the preimage): getNoteHash(npk, tokenData, value) = poseidon([npk,
 * tokenHash, value]) with value AS-IS (the contract already deducted the fee — §3). fee is
 * fees[i] with the engine's truthiness (zero/absent ⇒ undefined); from is always undefined.
 * Verified against engine 9.5.1 V2Events.formatShieldCommitments + note-util.getNoteHash.
 * Requires initPoseidonWasm() to have run.
 */
function shieldEventOf(
  row: RawLogRow,
  args: {
    treeNumber: number | bigint;
    startPosition: number | bigint;
    commitments: readonly {
      npk: string;
      token: { tokenType: number | bigint; tokenAddress: string; tokenSubID: bigint };
      value: bigint;
    }[];
    shieldCiphertext: readonly { encryptedBundle: readonly string[]; shieldKey: string }[];
    fees: readonly bigint[];
  },
): QuickSyncCommitmentEvent {
  const utxoTree = Number(args.treeNumber);
  const startPosition = Number(args.startPosition);
  const txid = formatUint256(row.txHash);
  const commitments: QuickSyncShieldCommitment[] = args.commitments.map((pre, i) => {
    const tokenType = Number(pre.token.tokenType);
    // ERC20 tokenHash = address left-padded to 32 bytes; as a field element that is BigInt(addr).
    const tokenHash = bi(pre.token.tokenAddress);
    const noteHash = poseidonHash([bi(pre.npk), tokenHash, pre.value]);
    const bundle = args.shieldCiphertext[i]!.encryptedBundle;
    return {
      commitmentType: SHIELD_COMMITMENT_TYPE,
      hash: nToHex256(noteHash),
      txid,
      timestamp: undefined,
      blockNumber: Number(row.blockNumber),
      utxoTree,
      utxoIndex: startPosition + i,
      preImage: {
        npk: formatUint256(pre.npk),
        token: {
          tokenType,
          tokenAddress: serializeTokenAddress(pre.token.tokenAddress),
          tokenSubID: serializeTokenSubID(BigInt(pre.token.tokenSubID)),
        },
        value: formatValue128(pre.value),
      },
      encryptedBundle: [bundle[0]!, bundle[1]!, bundle[2]!],
      shieldKey: args.shieldCiphertext[i]!.shieldKey,
      fee: args.fees && args.fees[i] ? args.fees[i]!.toString() : undefined,
      from: undefined,
    };
  });
  return { txid, treeNumber: utxoTree, startPosition, commitments, blockNumber: Number(row.blockNumber) };
}

export function decodeShieldCommitments(rows: RawLogRow[]): QuickSyncCommitmentEvent[] {
  const out: QuickSyncCommitmentEvent[] = [];
  for (const row of rows) {
    const ev = decode(row);
    if (ev.eventName === "Shield") out.push(shieldEventOf(row, ev.args as never));
  }
  return out;
}

/**
 * All commitment events (Shield + Transact) in a SINGLE ordered pass — preserves the engine's
 * strict block/log ordering across both event kinds (rows must arrive block/log-ordered).
 */
export function decodeCommitmentEvents(rows: RawLogRow[]): QuickSyncCommitmentEvent[] {
  const out: QuickSyncCommitmentEvent[] = [];
  for (const row of rows) {
    const ev = decode(row);
    if (ev.eventName === "Shield") out.push(shieldEventOf(row, ev.args as never));
    else if (ev.eventName === "Transact") out.push(transactEventOf(row, ev.args as never));
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
