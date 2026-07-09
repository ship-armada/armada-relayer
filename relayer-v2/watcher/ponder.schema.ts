// ABOUTME: Indexed tables per spec §5.1 (semantic content normative; columns snake_case so the
// ABOUTME: actor's SQL reads them directly) plus raw_event_log backing /v1/logs (DEV-7).
import { onchainTable, index } from "ponder";

export const commitmentBatch = onchainTable(
  "commitment_batch",
  (t) => ({
    id: t.text("id").primaryKey(), // chainId:txHash:logIndex
    kind: t.text("kind").notNull(), // shield | transact
    treeNumber: t.integer("tree_number").notNull(),
    startPosition: t.integer("start_position").notNull(),
    commitmentCount: t.integer("commitment_count").notNull(),
    blockNumber: t.bigint("block_number").notNull(),
    txHash: t.text("tx_hash").notNull(),
    logIndex: t.integer("log_index").notNull(),
    rawData: t.text("raw_data").notNull(),
    rawTopics: t.text("raw_topics").notNull(),
  }),
  (table) => ({ blockIdx: index().on(table.blockNumber) }),
);

export const nullifier = onchainTable(
  "nullifier",
  (t) => ({
    id: t.text("id").primaryKey(), // chainId:txHash:logIndex:i
    treeNumber: t.integer("tree_number").notNull(),
    hash: t.text("hash").notNull(),
    blockNumber: t.bigint("block_number").notNull(),
    txHash: t.text("tx_hash").notNull(),
    logIndex: t.integer("log_index").notNull(),
  }),
  (table) => ({ blockIdx: index().on(table.blockNumber) }),
);

export const unshield = onchainTable(
  "unshield",
  (t) => ({
    id: t.text("id").primaryKey(),
    toAddress: t.text("to_address").notNull(),
    tokenAddress: t.text("token_address").notNull(),
    amount: t.numeric("amount").notNull(),
    fee: t.numeric("fee").notNull(),
    blockNumber: t.bigint("block_number").notNull(),
    txHash: t.text("tx_hash").notNull(),
  }),
  (table) => ({ blockIdx: index().on(table.blockNumber) }),
);

export const cctpMessageSent = onchainTable(
  "cctp_message_sent",
  (t) => ({
    id: t.text("id").primaryKey(), // dedupKey: sourceTxHash:logIndex (v1 convention)
    chainId: t.integer("chain_id").notNull(),
    sourceDomain: t.integer("source_domain").notNull(),
    destinationDomain: t.integer("destination_domain").notNull(),
    messageBytes: t.text("message_bytes").notNull(),
    messageHash: t.text("message_hash").notNull(),
    sourceTxHash: t.text("source_tx_hash").notNull(),
    logIndex: t.integer("log_index").notNull(),
    blockNumber: t.bigint("block_number").notNull(),
    blockTimestamp: t.bigint("block_timestamp").notNull(),
  }),
  (table) => ({ chainBlockIdx: index().on(table.chainId, table.blockNumber) }),
);

export const cctpMessageReceived = onchainTable(
  "cctp_message_received",
  (t) => ({
    id: t.text("id").primaryKey(),
    chainId: t.integer("chain_id").notNull(),
    sourceDomain: t.integer("source_domain").notNull(),
    nonce: t.text("nonce").notNull(),
    caller: t.text("caller").notNull(),
    destinationTxHash: t.text("destination_tx_hash").notNull(),
    blockNumber: t.bigint("block_number").notNull(),
  }),
  (table) => ({ nonceIdx: index().on(table.sourceDomain, table.nonce) }),
);

export const xchainInitiated = onchainTable("xchain_initiated", (t) => ({
  id: t.text("id").primaryKey(),
  chainId: t.integer("chain_id").notNull(),
  kind: t.text("kind").notNull(), // shield | unshield
  domain: t.integer("domain").notNull(),
  amount: t.numeric("amount").notNull(),
  nonce: t.text("nonce").notNull(),
  txHash: t.text("tx_hash").notNull(),
  blockNumber: t.bigint("block_number").notNull(),
}));

export const unshieldReceived = onchainTable("unshield_received", (t) => ({
  id: t.text("id").primaryKey(),
  chainId: t.integer("chain_id").notNull(),
  recipient: t.text("recipient").notNull(),
  amount: t.numeric("amount").notNull(),
  txHash: t.text("tx_hash").notNull(),
  blockNumber: t.bigint("block_number").notNull(),
}));

// Raw copy of every indexed protocol-contract log, backing GET /v1/logs (§7.3). Addition
// to the §5.1 catalogue recorded as DEV-7 in .context/deviations.md.
export const rawEventLog = onchainTable(
  "raw_event_log",
  (t) => ({
    id: t.text("id").primaryKey(), // chainId:txHash:logIndex
    chainId: t.integer("chain_id").notNull(),
    address: t.text("address").notNull(),
    blockNumber: t.bigint("block_number").notNull(),
    txHash: t.text("tx_hash").notNull(),
    logIndex: t.integer("log_index").notNull(),
    data: t.text("data").notNull(),
    topics: t.text("topics").notNull(), // JSON array
  }),
  (table) => ({ addrBlockIdx: index().on(table.chainId, table.address, table.blockNumber) }),
);
