// ABOUTME: Quick-sync response types + builder (spec §7.3): serves the Railgun engine's
// ABOUTME: AccumulatedEvents for a chain from stored raw logs. Pinned to engine 9.5.1 shapes.

// These mirror @railgun-community/engine's AccumulatedEvents exactly; test/quick-sync-types.ts
// asserts assignability at compile time so an engine bump fails the build (§7.3, B3).
// The watcher takes NO *runtime* dependency on the engine (S6): the CommitmentType import below
// is `import type` (erased at build), and the runtime builder assigns the enum's own string
// value. Only the compile-time pin + the ground-truth test touch the engine (devDependency).
import type { CommitmentType } from "@railgun-community/engine";

// The enum's runtime value equals its name (e.g. CommitmentType.ShieldCommitment === "ShieldCommitment"),
// so the builder constructs with the string literal cast to the member type — see buildShield/Transact.
export const SHIELD_COMMITMENT_TYPE = "ShieldCommitment" as CommitmentType.ShieldCommitment;
export const TRANSACT_COMMITMENT_V2_TYPE = "TransactCommitmentV2" as CommitmentType.TransactCommitmentV2;

// The engine declares Optional fields as REQUIRED keys with `| undefined` values (Optional<T>),
// so these use `field: T | undefined` (not `field?: T`) — assignable to the engine type AND
// forcing the builder to always emit the key (deep-equal needs e.g. `fee: undefined` present).
export interface QuickSyncCommitmentShared {
  hash: string; // UINT_256 hex, unprefixed lowercase (64 chars)
  txid: string; // UINT_256 hex, unprefixed lowercase
  blockNumber: number;
  timestamp: number | undefined;
  utxoTree: number;
  utxoIndex: number;
}

export interface QuickSyncShieldCommitment extends QuickSyncCommitmentShared {
  commitmentType: CommitmentType.ShieldCommitment;
  preImage: { npk: string; token: { tokenType: number; tokenAddress: string; tokenSubID: string }; value: string };
  encryptedBundle: [string, string, string];
  shieldKey: string;
  fee: string | undefined; // zero/absent fee ⇒ undefined (engine truthiness, §3)
  from: string | undefined; // always undefined on the scan path
}

export interface QuickSyncTransactCommitment extends QuickSyncCommitmentShared {
  commitmentType: CommitmentType.TransactCommitmentV2;
  ciphertext: {
    ciphertext: { iv: string; tag: string; data: string[] };
    blindedSenderViewingKey: string;
    blindedReceiverViewingKey: string;
    annotationData: string;
    memo: string;
  };
  railgunTxid: string | undefined;
}

export type QuickSyncCommitment = QuickSyncShieldCommitment | QuickSyncTransactCommitment;

export interface QuickSyncCommitmentEvent {
  txid: string;
  treeNumber: number;
  startPosition: number;
  commitments: QuickSyncCommitment[];
  blockNumber: number;
}

export interface QuickSyncUnshieldEvent {
  txid: string;
  timestamp: number | undefined;
  toAddress: string;
  tokenType: number;
  tokenAddress: string;
  tokenSubID: string;
  amount: string;
  fee: string;
  blockNumber: number;
  eventLogIndex: number | undefined; // populated from the stored logIndex (§3)
  railgunTxid: string | undefined;
  poisPerList: undefined;
}

export interface QuickSyncNullifier {
  nullifier: string; // UINT_256 hex, unprefixed lowercase
  treeNumber: number;
  txid: string;
  blockNumber: number;
}

/** The AccumulatedEvents subset the watcher serves (V2 protocol — no V3 railgunTransactionEvents). */
export interface QuickSyncResponse {
  commitmentEvents: QuickSyncCommitmentEvent[];
  unshieldEvents: QuickSyncUnshieldEvent[];
  nullifierEvents: QuickSyncNullifier[];
}

export function emptyQuickSync(): QuickSyncResponse {
  return { commitmentEvents: [], unshieldEvents: [], nullifierEvents: [] };
}
