// ABOUTME: Shared test fixtures: synthetic CCTP V2 message builder matching the §8.5 byte
// ABOUTME: layout, and a CctpJob factory for state-machine and repo tests.
import { concat, zeroPadValue, toBeHex, keccak256 } from "ethers";
import type { CctpJob } from "../src/db/types.js";
import type { IndexedMessageSent } from "../src/db/types.js";

export interface MessageParams {
  sourceDomain?: number;
  destinationDomain?: number;
  nonce?: string; // bytes32
  destinationCaller?: string; // bytes32
  bodyVersion?: number;
  mintRecipient?: string; // bytes32
  truncate?: number; // cut the message to N bytes
}

export const ZERO32 = "0x" + "00".repeat(32);
export const POOL_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
export const HOOK_ROUTER = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0";

function u32(n: number): string {
  return zeroPadValue(toBeHex(n), 4);
}

export function buildCctpMessage(params: MessageParams = {}): string {
  const {
    sourceDomain = 101,
    destinationDomain = 100,
    nonce = ZERO32,
    destinationCaller = ZERO32,
    bodyVersion = 1,
    mintRecipient = zeroPadValue(POOL_ADDRESS, 32),
  } = params;
  const header = concat([
    u32(1), // header version
    u32(sourceDomain),
    u32(destinationDomain),
    nonce,
    ZERO32, // sender
    ZERO32, // recipient
    destinationCaller,
    u32(0), // minFinalityThreshold
    u32(0), // finalityThresholdExecuted
  ]);
  const body = concat([
    u32(bodyVersion),
    ZERO32, // burnToken
    mintRecipient,
    ZERO32, // amount
    ZERO32, // messageSender
    ZERO32, // maxFee
    ZERO32, // feeExecuted
    ZERO32, // expirationBlock
  ]);
  const message = concat([header, body]);
  if (params.truncate !== undefined) {
    return message.slice(0, 2 + params.truncate * 2);
  }
  return message;
}

export function mkJob(overrides: Partial<CctpJob> = {}): CctpJob {
  const messageBytes = overrides.messageBytes ?? buildCctpMessage();
  return {
    dedupKey: "0x" + "11".repeat(32) + ":0",
    messageHash: keccak256(messageBytes),
    messageBytes,
    sourceDomain: 101,
    destinationDomain: 100,
    nonce: ZERO32,
    sourceTxHash: "0x" + "11".repeat(32),
    sourceBlock: 100n,
    state: "detected",
    detectedAt: new Date("2026-01-01T00:00:00Z"),
    pollAttempts: 0,
    lastIrisStatus: null,
    attestation: null,
    relayMessage: null,
    retryAttempts: 0,
    nextRetryAt: null,
    submittedTxHash: null,
    submittedAt: null,
    deliveredTxHash: null,
    deliveredBlock: null,
    deliveredAt: null,
    deadLetterReason: null,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

export function mkIndexedMessage(
  overrides: Partial<IndexedMessageSent> = {},
): IndexedMessageSent {
  const messageBytes = overrides.messageBytes ?? buildCctpMessage();
  const sourceTxHash = overrides.sourceTxHash ?? "0x" + "22".repeat(32);
  return {
    id: `${sourceTxHash}:0`,
    chainId: 31338,
    sourceDomain: 101,
    destinationDomain: 100,
    messageBytes,
    messageHash: keccak256(messageBytes),
    sourceTxHash,
    logIndex: 0,
    blockNumber: 100n,
    blockTimestamp: 1_700_000_000n,
    ...overrides,
  };
}
