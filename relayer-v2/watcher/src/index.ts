// ABOUTME: Ponder indexing functions: writes the §5.1 event catalogue to Postgres, storing
// ABOUTME: raw log data/topics verbatim so the read API serves Raw* envelopes without re-encoding.
import { ponder } from "ponder:registry";
import * as schema from "ponder:schema";
import { join } from "node:path";
import { decodeCctpHeader, messageHashOf, logRowId, dedupKey, serializeTopics } from "./lib/decode";
import { hubDomain, watcherMode } from "./lib/manifests";

// Deployments root (topology.json + manifests) — mirrors ponder.config's resolution.
const deploymentsRoot =
  process.env.DEPLOYMENTS_DIR ?? join(process.cwd(), "..", "..", "deployments");
// Hub CCTP domain, resolved once: xchain_initiated rows carry no domain (destination is the hub).
const HUB_DOMAIN = hubDomain(process.env, deploymentsRoot);

type AnyEvent = {
  log: { logIndex: number; data: `0x${string}`; topics: readonly `0x${string}`[]; address: `0x${string}` };
  block: { number: bigint; timestamp: bigint };
  transaction: { hash: `0x${string}` };
};

async function recordRawLog(
  context: { db: { insert: Function }; chain: { id: number } },
  event: AnyEvent,
): Promise<void> {
  await context.db
    .insert(schema.rawEventLog)
    .values({
      id: logRowId(context.chain.id, event.transaction.hash, event.log.logIndex),
      chainId: context.chain.id,
      address: event.log.address.toLowerCase(),
      blockNumber: event.block.number,
      txHash: event.transaction.hash,
      logIndex: event.log.logIndex,
      data: event.log.data,
      topics: serializeTopics(event.log.topics as string[]),
    })
    .onConflictDoNothing();
}

// Pool indexing (Railgun commitments/nullifiers/unshields + xchain rows) runs only in "full"
// mode. cctp-only drops the pool contracts from ponder.config's runtime value, so registering
// their handlers here would fail Ponder's contract↔handler validation at build — both sides read
// watcherMode so they stay in lockstep. The CCTP handlers below always register.
const poolIndexing = watcherMode(process.env) === "full";

if (poolIndexing) {
  ponder.on("PrivacyPool:Shield", async ({ event, context }) => {
    await context.db
      .insert(schema.commitmentBatch)
      .values({
        id: logRowId(context.chain.id, event.transaction.hash, event.log.logIndex),
        kind: "shield",
        treeNumber: Number(event.args.treeNumber),
        startPosition: Number(event.args.startPosition),
        commitmentCount: event.args.commitments.length,
        blockNumber: event.block.number,
        txHash: event.transaction.hash,
        logIndex: event.log.logIndex,
        rawData: event.log.data,
        rawTopics: serializeTopics(event.log.topics as string[]),
      })
      // Reorg reconciliation can re-run a handler for an already-flushed event; the
      // (txHash:logIndex) key can only ever carry identical data, so ignore the re-insert.
      .onConflictDoNothing();
    await recordRawLog(context, event as unknown as AnyEvent);
  });

  ponder.on("PrivacyPool:Transact", async ({ event, context }) => {
    await context.db
      .insert(schema.commitmentBatch)
      .values({
        id: logRowId(context.chain.id, event.transaction.hash, event.log.logIndex),
        kind: "transact",
        treeNumber: Number(event.args.treeNumber),
        startPosition: Number(event.args.startPosition),
        commitmentCount: event.args.hash.length,
        blockNumber: event.block.number,
        txHash: event.transaction.hash,
        logIndex: event.log.logIndex,
        rawData: event.log.data,
        rawTopics: serializeTopics(event.log.topics as string[]),
      })
      .onConflictDoNothing();
    await recordRawLog(context, event as unknown as AnyEvent);
  });

  ponder.on("PrivacyPool:Nullified", async ({ event, context }) => {
    // One row per array element (§5.1).
    for (let i = 0; i < event.args.nullifier.length; i++) {
      await context.db
        .insert(schema.nullifier)
        .values({
          id: `${logRowId(context.chain.id, event.transaction.hash, event.log.logIndex)}:${i}`,
          treeNumber: Number(event.args.treeNumber),
          hash: event.args.nullifier[i]!,
          blockNumber: event.block.number,
          txHash: event.transaction.hash,
          logIndex: event.log.logIndex,
        })
        .onConflictDoNothing();
    }
    await recordRawLog(context, event as unknown as AnyEvent);
  });

  ponder.on("PrivacyPool:Unshield", async ({ event, context }) => {
    await context.db
      .insert(schema.unshield)
      .values({
        id: logRowId(context.chain.id, event.transaction.hash, event.log.logIndex),
        toAddress: event.args.to,
        tokenAddress: event.args.token.tokenAddress,
        amount: event.args.amount.toString(),
        fee: event.args.fee.toString(),
        blockNumber: event.block.number,
        txHash: event.transaction.hash,
      })
      .onConflictDoNothing();
    await recordRawLog(context, event as unknown as AnyEvent);
  });

  ponder.on("PrivacyPool:CrossChainUnshieldInitiated", async ({ event, context }) => {
    await context.db
      .insert(schema.xchainInitiated)
      .values({
        id: logRowId(context.chain.id, event.transaction.hash, event.log.logIndex),
        chainId: context.chain.id,
        kind: "unshield",
        domain: Number(event.args.destinationDomain),
        amount: event.args.amount.toString(),
        nonce: event.args.nonce.toString(),
        txHash: event.transaction.hash,
        blockNumber: event.block.number,
      })
      .onConflictDoNothing();
    await recordRawLog(context, event as unknown as AnyEvent);
  });

  ponder.on("PrivacyPoolClient:CrossChainShieldInitiated", async ({ event, context }) => {
    await context.db
      .insert(schema.xchainInitiated)
      .values({
        id: logRowId(context.chain.id, event.transaction.hash, event.log.logIndex),
        chainId: context.chain.id,
        kind: "shield",
        domain: HUB_DOMAIN, // event carries no domain; destination is the hub
        amount: event.args.amount.toString(),
        nonce: event.args.nonce.toString(),
        txHash: event.transaction.hash,
        blockNumber: event.block.number,
      })
      .onConflictDoNothing();
    await recordRawLog(context, event as unknown as AnyEvent);
  });

  ponder.on("PrivacyPoolClient:UnshieldReceived", async ({ event, context }) => {
    await context.db
      .insert(schema.unshieldReceived)
      .values({
        id: logRowId(context.chain.id, event.transaction.hash, event.log.logIndex),
        chainId: context.chain.id,
        recipient: event.args.recipient,
        amount: event.args.amount.toString(),
        txHash: event.transaction.hash,
        blockNumber: event.block.number,
      })
      .onConflictDoNothing();
    await recordRawLog(context, event as unknown as AnyEvent);
  });
}

ponder.on("MessageTransmitter:MessageSent", async ({ event, context }) => {
  const message = event.args.message;
  let header;
  try {
    header = decodeCctpHeader(message);
  } catch {
    return; // not a CCTP V2 message; nothing to index
  }
  await context.db
    .insert(schema.cctpMessageSent)
    .values({
      id: dedupKey(event.transaction.hash, event.log.logIndex), // v1 dedupKey convention (§3)
      chainId: context.chain.id,
      sourceDomain: header.sourceDomain,
      destinationDomain: header.destinationDomain,
      messageBytes: message,
      messageHash: messageHashOf(message),
      sourceTxHash: event.transaction.hash,
      logIndex: event.log.logIndex,
      blockNumber: event.block.number,
      blockTimestamp: event.block.timestamp,
    })
    .onConflictDoNothing();
  await recordRawLog(context, event as unknown as AnyEvent);
});

ponder.on("MessageTransmitter:MessageReceived", async ({ event, context }) => {
  await context.db
    .insert(schema.cctpMessageReceived)
    .values({
      id: logRowId(context.chain.id, event.transaction.hash, event.log.logIndex),
      chainId: context.chain.id,
      sourceDomain: Number(event.args.sourceDomain),
      nonce: event.args.nonce,
      caller: event.args.caller,
      destinationTxHash: event.transaction.hash,
      blockNumber: event.block.number,
    })
    .onConflictDoNothing();
  await recordRawLog(context, event as unknown as AnyEvent);
});
