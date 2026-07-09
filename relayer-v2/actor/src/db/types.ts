// ABOUTME: Shared domain types for the actor's job pipeline: job states (§8.4),
// ABOUTME: the CctpJob row model (§5.2), and indexed-view row shapes the actor reads (§5.1).

export type JobState =
  | "detected"
  | "awaiting_attestation"
  | "attested"
  | "submitted"
  | "delivered"
  | "dead_letter"
  | "skipped"
  | "already_delivered";

export interface CctpJob {
  dedupKey: string; // "${sourceTxHash}:${logIndex}"
  messageHash: string;
  messageBytes: string;
  sourceDomain: number;
  destinationDomain: number;
  nonce: string;
  sourceTxHash: string;
  sourceBlock: bigint;
  state: JobState;
  detectedAt: Date;
  pollAttempts: number;
  lastIrisStatus: string | null;
  attestation: string | null;
  retryAttempts: number;
  nextRetryAt: Date | null;
  submittedTxHash: string | null;
  submittedAt: Date | null;
  deliveredTxHash: string | null;
  deliveredBlock: bigint | null;
  deliveredAt: Date | null;
  deadLetterReason: string | null;
  updatedAt: Date;
}

/** Row shape of the watcher's indexed cctp_message_sent view (§5.1). */
export interface IndexedMessageSent {
  id: string; // dedupKey
  chainId: number;
  sourceDomain: number;
  destinationDomain: number;
  messageBytes: string;
  messageHash: string;
  sourceTxHash: string;
  logIndex: number;
  blockNumber: bigint;
  blockTimestamp: bigint;
}

/** Per-chain watcher indexing progress, read from Postgres (§6.6, §8.3, §8.7). */
export interface WatcherChainProgress {
  chainId: number;
  lastIndexedBlock: bigint;
  lastIndexedBlockTimestamp: Date | null;
  ready: boolean;
}
