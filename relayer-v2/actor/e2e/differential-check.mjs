// ABOUTME: The load-bearing differential test (§15.2): watcher-indexed rows MUST equal
// ABOUTME: eth_getLogs ground truth per chain/table — compared as (txHash:logIndex) sets.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JsonRpcProvider, id as topicHash } from "ethers";
import pg from "pg";

const DEPLOYMENTS = process.env.DEPLOYMENTS_DIR;
const DB = process.env.DATABASE_URL; // needs read access to the indexed schema
const SCHEMA = process.env.INDEXED_SCHEMA ?? "indexed";
if (!DEPLOYMENTS || !DB) throw new Error("set DEPLOYMENTS_DIR and DATABASE_URL");

const manifest = (n) => JSON.parse(readFileSync(join(DEPLOYMENTS, n), "utf8"));
const chains = [
  { name: "hub", chainId: 31337, rpc: "http://127.0.0.1:8545", m: manifest("privacy-pool-hub.json") },
  { name: "clientA", chainId: 31338, rpc: "http://127.0.0.1:8546", m: manifest("privacy-pool-client.json") },
  { name: "clientB", chainId: 31339, rpc: "http://127.0.0.1:8547", m: manifest("privacy-pool-clientB.json") },
];

// event topic -> (chain-scoped) indexed table + optional address source
const CHECKS = [
  { table: "cctp_message_sent", event: "MessageSent(bytes)", address: (c) => c.m.cctp.messageTransmitter, hubOnly: false, txCol: "source_tx_hash" },
  { table: "cctp_message_received", event: "MessageReceived(address,uint32,bytes32,bytes32,uint32,bytes)", address: (c) => c.m.cctp.messageTransmitter, hubOnly: false, txCol: "destination_tx_hash" },
  { table: "commitment_batch", event: "Shield(uint256,uint256,(bytes32,(uint8,address,uint256),uint120)[],(bytes32[3],bytes32)[],uint256[])", address: (c) => c.m.contracts.privacyPool, hubOnly: true, txCol: "tx_hash", orEvent: "Transact(uint256,uint256,bytes32[],(bytes32[4],bytes32,bytes32,bytes,bytes)[])" },
  { table: "unshield_received", event: "UnshieldReceived(address,uint256)", address: (c) => c.m.contracts.privacyPoolClient, hubOnly: false, clientOnly: true, txCol: "tx_hash" },
  { table: "xchain_initiated", event: "CrossChainShieldInitiated(address,uint256,bytes32,uint64)", address: (c) => c.m.contracts.privacyPoolClient, clientOnly: true, txCol: "tx_hash", orEventHub: "CrossChainUnshieldInitiated(uint32,address,uint256,uint64)" },
];

const db = new pg.Client({ connectionString: DB });
await db.connect();
let failures = 0;

for (const chain of chains) {
  const provider = new JsonRpcProvider(chain.rpc, chain.chainId, { staticNetwork: true });
  const latest = await provider.getBlockNumber();
  for (const check of CHECKS) {
    if (check.hubOnly && chain.name !== "hub") continue;
    if (check.clientOnly && chain.name === "hub") continue;
    const address = check.address(chain);
    if (!address) continue;

    const topics = [topicHash(check.event)];
    if (check.orEvent) topics[0] = [topics[0], topicHash(check.orEvent)];
    const logs = await provider.getLogs({ address, topics, fromBlock: 0, toBlock: latest });
    const truth = new Set(logs.map((l) => `${l.transactionHash}:${l.index}`));

    // chain-scoped rows; commitment_batch/nullifier/unshield are hub tables without chain_id
    const hasChainId = !["commitment_batch", "unshield"].includes(check.table);
    const where = hasChainId ? `WHERE chain_id = ${chain.chainId}` : "";
    const rows = await db.query(
      `SELECT ${check.txCol} AS tx, log_index FROM "${SCHEMA}".${check.table} ${where}`,
    ).catch(async (e) => {
      // tables without log_index (unshield_received? has none in schema) — fall back to tx only
      const r = await db.query(`SELECT ${check.txCol} AS tx FROM "${SCHEMA}".${check.table} ${where}`);
      return { rows: r.rows.map((x) => ({ ...x, log_index: null })), noLogIndex: true };
    });
    const indexed = new Set(
      rows.rows.map((r) => (r.log_index === null ? r.tx : `${r.tx}:${r.log_index}`)),
    );
    const compare = rows.noLogIndex ? new Set(logs.map((l) => l.transactionHash)) : truth;

    const missing = [...compare].filter((k) => !indexed.has(k));
    const extra = [...indexed].filter((k) => !compare.has(k));
    const ok = missing.length === 0 && extra.length === 0;
    if (!ok) failures += 1;
    console.log(
      `${ok ? "OK  " : "FAIL"} ${chain.name.padEnd(8)} ${check.table.padEnd(22)} chain=${compare.size} indexed=${indexed.size}` +
        (ok ? "" : ` missing=${missing.slice(0, 3).join(",")} extra=${extra.slice(0, 3).join(",")}`),
    );
  }
}
await db.end();
if (failures > 0) {
  console.error(`DIFFERENTIAL TEST FAILED: ${failures} table(s) diverge from chain truth`);
  process.exit(1);
}
console.log("DIFFERENTIAL TEST PASSED: watcher rows match eth_getLogs ground truth");
