// ABOUTME: Interim @armada/sdk-native quick-sync serializer — decodes stored raw Hub logs straight into
// ABOUTME: the SDK's wire shape (armada-sdk quick-sync-wire.ts), superseded by the #26 native-only cutover.
//
// The watcher's /v1 quick-sync serves the Railgun engine's AccumulatedEvents. The armada-interface,
// via @armada/sdk's IndexerEventSource, instead calls /v2/quick-sync and validates the body with
// parseQuickSync, which expects a different, flatter shape: a versioned envelope with per-commitment
// `shields`/`transacts`/`nullifiers`/`unshields`, bigints as decimal strings, and no engine framing.
// This module produces exactly that shape. It is a hand-rolled mirror of the SDK's wire contract
// (deliberately NOT importing @armada/sdk yet — that dependency + the removal of the engine path is
// the definitive migration tracked in #26). NATIVE_QUICK_SYNC_SCHEMA_VERSION and the field encodings
// below MUST track the SDK's; the quick-sync-native test pins them.
import { decodeEventLog } from "viem";
import { PrivacyPoolAbi } from "../../../abis/PrivacyPool";
import type { RawLogRow } from "./quick-sync-decode";
import { poseidonHash } from "./poseidon";

/** Mirrors @armada/sdk QUICK_SYNC_SCHEMA_VERSION; parseQuickSync rejects a mismatch, so bump in lockstep. */
export const NATIVE_QUICK_SYNC_SCHEMA_VERSION = 1;

// ── Wire shapes (SDK-native): a flat, JSON-safe projection consumed by parseQuickSync ──
// Encoding conventions (differ from /v1's engine ByteUtils shapes):
//   - hashes / npk / keys / bundles / ciphertext elements: unprefixed lowercase hex.
//   - value / fee / amount / nullifier / tokenSubID: decimal strings.
//   - tokenData.tokenAddress: lowercase 0x-address (20 bytes) — NOT 32-byte padded.
//   - txid: the 0x-prefixed transaction hash (matches the SDK's RPC-decode `meta.txid`).
export interface NativeWireTokenData {
  tokenType: number;
  tokenAddress: string;
  tokenSubID: string;
}

export interface NativeWireShieldCommitment {
  tree: number;
  position: number;
  blockNumber: number;
  txid: string;
  hash: string; // poseidon([npk, tokenHash, value]), 64-char no-0x
  npk: string; // no-0x
  tokenData: NativeWireTokenData;
  value: string; // decimal
  encryptedBundle: [string, string, string]; // no-0x
  shieldKey: string; // no-0x
  fee?: string; // decimal; present whenever the event carried a fee entry (incl. "0")
}

export interface NativeWireCommitmentCiphertext {
  ciphertext: string[]; // the raw bytes32[4] [ivTag, d0, d1, d2], each no-0x (parseQuickSync requires length 4)
  blindedSenderViewingKey: string; // no-0x
  blindedReceiverViewingKey: string; // no-0x
  memo: string; // bytes hex, as decoded
  annotationData: string; // bytes hex, as decoded
}

export interface NativeWireTransactCommitment {
  tree: number;
  position: number;
  blockNumber: number;
  txid: string;
  hash: string; // no-0x (event-provided)
  ciphertext: NativeWireCommitmentCiphertext;
}

export interface NativeWireNullifier {
  tree: number;
  nullifier: string; // decimal
  blockNumber: number;
  txid: string;
}

export interface NativeWireUnshield {
  to: string; // 0x-address
  tokenData: NativeWireTokenData;
  amount: string; // decimal
  fee: string; // decimal
  blockNumber: number;
  txid: string;
}

export interface NativeQuickSyncResponse {
  schemaVersion: number;
  syncedThroughBlock: number;
  shields: NativeWireShieldCommitment[];
  transacts: NativeWireTransactCommitment[];
  nullifiers: NativeWireNullifier[];
  unshields: NativeWireUnshield[];
}

// ── encoding helpers ──

/** Unprefixed lowercase hex (matches the SDK's strip0x; viem already emits lowercase). */
const strip0x = (hex: string): string => (hex.startsWith("0x") ? hex.slice(2) : hex).toLowerCase();
/** Field element from 0x-or-bare hex. */
const bi = (hex: string): bigint => BigInt(hex.startsWith("0x") ? hex : `0x${hex}`);
/** 64-char unprefixed lowercase hex of a field element. */
const nToHex256 = (n: bigint): string => n.toString(16).padStart(64, "0");

function decode(row: RawLogRow) {
  return decodeEventLog({
    abi: PrivacyPoolAbi,
    data: row.data as `0x${string}`,
    topics: row.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
  });
}

/** Shield → one leaf per commitment. Hash is COMPUTED: poseidon([npk, tokenHash, value]); ERC20 only
 *  (tokenHash = address as field element). Requires initPoseidonWasm() to have run. */
export function nativeShields(rows: RawLogRow[]): NativeWireShieldCommitment[] {
  const out: NativeWireShieldCommitment[] = [];
  for (const row of rows) {
    const ev = decode(row);
    if (ev.eventName !== "Shield") continue;
    const args = ev.args as {
      treeNumber: number | bigint;
      startPosition: number | bigint;
      commitments: readonly {
        npk: string;
        token: { tokenType: number | bigint; tokenAddress: string; tokenSubID: bigint };
        value: bigint;
      }[];
      shieldCiphertext: readonly { encryptedBundle: readonly string[]; shieldKey: string }[];
      fees: readonly bigint[];
    };
    const tree = Number(args.treeNumber);
    const start = Number(args.startPosition);
    args.commitments.forEach((pre, i) => {
      const tokenType = Number(pre.token.tokenType);
      // The Armada pools are ERC20-only; refuse rather than emit a silently-wrong hash for any future
      // NFT shield (ERC721/1155 use a different tokenHash). Mirrors /v1's guard.
      if (tokenType !== 0) {
        throw new Error(
          `quick-sync: unsupported shield tokenType ${tokenType} (only ERC20 tokenHash is implemented)`,
        );
      }
      const tokenAddress = pre.token.tokenAddress.toLowerCase();
      const npk = strip0x(pre.npk);
      const value = BigInt(pre.value);
      // ERC20 tokenHash = address as a field element = BigInt(address).
      const hash = nToHex256(poseidonHash([bi(pre.npk), bi(tokenAddress), value]));
      const sc = args.shieldCiphertext[i]!;
      const fee = args.fees?.[i];
      out.push({
        tree,
        position: start + i,
        blockNumber: Number(row.blockNumber),
        txid: row.txHash.toLowerCase(),
        hash,
        npk,
        tokenData: {
          tokenType,
          tokenAddress,
          tokenSubID: BigInt(pre.token.tokenSubID).toString(),
        },
        value: value.toString(),
        encryptedBundle: [
          strip0x(sc.encryptedBundle[0]!),
          strip0x(sc.encryptedBundle[1]!),
          strip0x(sc.encryptedBundle[2]!),
        ],
        shieldKey: strip0x(sc.shieldKey),
        ...(fee === undefined ? {} : { fee: BigInt(fee).toString() }),
      });
    });
  }
  return out;
}

/** Transact → one leaf per commitment; hash is GIVEN in the event's hash[]. Ciphertext is the raw
 *  bytes32[4] envelope [ivTag, d0, d1, d2] (no engine iv/tag split — the SDK unpacks it itself). */
export function nativeTransacts(rows: RawLogRow[]): NativeWireTransactCommitment[] {
  const out: NativeWireTransactCommitment[] = [];
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
    const tree = Number(args.treeNumber);
    const start = Number(args.startPosition);
    args.ciphertext.forEach((cc, i) => {
      out.push({
        tree,
        position: start + i,
        blockNumber: Number(row.blockNumber),
        txid: row.txHash.toLowerCase(),
        hash: strip0x(args.hash[i]!),
        ciphertext: {
          ciphertext: cc.ciphertext.map(strip0x),
          blindedSenderViewingKey: strip0x(cc.blindedSenderViewingKey),
          blindedReceiverViewingKey: strip0x(cc.blindedReceiverViewingKey),
          memo: cc.memo,
          annotationData: cc.annotationData,
        },
      });
    });
  }
  return out;
}

/** Nullified → one nullifier per array element, decimal-encoded. */
export function nativeNullifiers(rows: RawLogRow[]): NativeWireNullifier[] {
  const out: NativeWireNullifier[] = [];
  for (const row of rows) {
    const ev = decode(row);
    if (ev.eventName !== "Nullified") continue;
    const args = ev.args as { treeNumber: number | bigint; nullifier: readonly string[] };
    for (const n of args.nullifier) {
      out.push({
        tree: Number(args.treeNumber),
        nullifier: bi(n).toString(),
        blockNumber: Number(row.blockNumber),
        txid: row.txHash.toLowerCase(),
      });
    }
  }
  return out;
}

/** Unshield → one public withdrawal, token data nested, amounts decimal-encoded. */
export function nativeUnshields(rows: RawLogRow[]): NativeWireUnshield[] {
  const out: NativeWireUnshield[] = [];
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
      to: args.to,
      tokenData: {
        tokenType: Number(args.token.tokenType),
        tokenAddress: args.token.tokenAddress.toLowerCase(),
        tokenSubID: BigInt(args.token.tokenSubID).toString(),
      },
      amount: BigInt(args.amount).toString(),
      fee: BigInt(args.fee).toString(),
      blockNumber: Number(row.blockNumber),
      txid: row.txHash.toLowerCase(),
    });
  }
  return out;
}

/** Build the full @armada/sdk-native quick-sync envelope from block/log-ordered raw hub logs. */
export function serializeNativeQuickSync(
  rows: RawLogRow[],
  syncedThroughBlock: number,
): NativeQuickSyncResponse {
  return {
    schemaVersion: NATIVE_QUICK_SYNC_SCHEMA_VERSION,
    syncedThroughBlock,
    shields: nativeShields(rows),
    transacts: nativeTransacts(rows),
    nullifiers: nativeNullifiers(rows),
    unshields: nativeUnshields(rows),
  };
}
