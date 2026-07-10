// ABOUTME: Work discovery (§8.3): finds unclaimed indexed MessageSent rows behind the
// ABOUTME: confirmation gate, classifies fail-closed, and claims them as job rows. Zero RPC.
import { keccak256 } from "ethers";
import type { IndexedReader } from "../db/indexed-reader.js";
import type { JobsRepo } from "../db/jobs-repo.js";
import type { CctpJob, IndexedMessageSent } from "../db/types.js";
import { classifyMessageForRelay, decodeMessageHeader } from "./classify.js";
import { logger } from "../logger.js";

const ZERO_NONCE = "0x" + "00".repeat(32);
export const DISCOVERY_BATCH_LIMIT = 100;

export interface DiscoveryContext {
  jobs: JobsRepo;
  indexed: IndexedReader;
  knownRecipients: ReadonlySet<string>; // bytes32-padded pool addresses, all chains (§8.5)
  hookRouterByDomain: Map<number, string | null>;
  confirmationsByChain: Map<number, number>;
  irisMode: "mock" | "iris";
  now: () => Date;
  onTransition?: (from: string, to: string) => void;
}

function newJob(msg: IndexedMessageSent, state: CctpJob["state"], now: Date): CctpJob {
  let nonce = ZERO_NONCE;
  try {
    nonce = decodeMessageHeader(msg.messageBytes).nonce;
  } catch {
    // unparseable header => classify below will skip the message anyway
  }
  return {
    dedupKey: msg.id,
    messageHash: msg.messageHash || keccak256(msg.messageBytes),
    messageBytes: msg.messageBytes,
    sourceDomain: msg.sourceDomain,
    destinationDomain: msg.destinationDomain,
    nonce,
    sourceTxHash: msg.sourceTxHash,
    sourceBlock: msg.blockNumber,
    state,
    detectedAt: now,
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
    updatedAt: now,
  };
}

/**
 * Classifies one message and claims it with the appropriate initial state. Shared by the
 * discovery tick and the fallback scanner (§8.7 feeds this same path).
 */
export async function claimMessage(
  ctx: DiscoveryContext,
  msg: IndexedMessageSent,
): Promise<CctpJob["state"] | null> {
  const now = ctx.now();
  const job = newJob(msg, "detected", now);

  const result = classifyMessageForRelay(
    msg.messageBytes,
    ctx.knownRecipients,
    ctx.hookRouterByDomain.get(msg.destinationDomain) ?? null,
  );
  if (!result.relay) {
    job.state = "skipped";
    job.deadLetterReason = result.reason; // skip reason recorded so re-discovery doesn't loop
  } else if (
    job.nonce !== ZERO_NONCE &&
    (await ctx.indexed.messageReceivedExists(msg.sourceDomain, job.nonce))
  ) {
    // Destination-side lookahead (§8.3). CCTP V2 nonces are zero at source, so this only
    // fires for messages carrying a source nonce; replay protection backstops the rest (D4).
    job.state = "already_delivered";
  }

  const claimed = await ctx.jobs.insertIfAbsent(job);
  if (!claimed) return null;
  ctx.onTransition?.("(none)", job.state);
  return job.state;
}

/** One discovery tick: claim up to DISCOVERY_BATCH_LIMIT confirmed, unclaimed messages. */
export async function discoverWork(ctx: DiscoveryContext): Promise<number> {
  const progress = await ctx.indexed.watcherProgress();
  const gate = new Map<number, bigint>();
  for (const p of progress) {
    const conf = ctx.confirmationsByChain.get(p.chainId);
    if (conf === undefined) continue;
    const max = p.lastIndexedBlock - BigInt(conf);
    if (max >= 0n) gate.set(p.chainId, max);
  }
  if (gate.size === 0) return 0; // watcher never ran => nothing to discover (fallback may engage)

  const messages = await ctx.indexed.unclaimedMessages(gate, DISCOVERY_BATCH_LIMIT);
  let claimed = 0;
  for (const msg of messages) {
    const state = await claimMessage(ctx, msg);
    if (state !== null) {
      claimed += 1;
      logger.info({ dedupKey: msg.id, state }, "claimed CCTP message");
    }
  }
  return claimed;
}
