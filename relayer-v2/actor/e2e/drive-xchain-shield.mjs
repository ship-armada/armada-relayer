// ABOUTME: e2e driver (§15.2): performs a real crossChainShield on client A against the local
// ABOUTME: anvil stack and waits for the actor to deliver it (polls /cctp/delivered).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JsonRpcProvider, Wallet, Contract, parseUnits, zeroPadValue } from "ethers";

const DEPLOYMENTS = process.env.DEPLOYMENTS_DIR;
const ACTOR_URL = process.env.ACTOR_URL ?? "http://127.0.0.1:3001";
const ANVIL_KEY0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
if (!DEPLOYMENTS) throw new Error("set DEPLOYMENTS_DIR to the monorepo deployments/ dir");

const manifest = (name) => JSON.parse(readFileSync(join(DEPLOYMENTS, name), "utf8"));
const client = manifest("privacy-pool-client.json"); // client A (31338, domain 101)
const hub = manifest("privacy-pool-hub.json");

const provider = new JsonRpcProvider("http://127.0.0.1:8546", 31338, { staticNetwork: true });
const deployer = new Wallet(ANVIL_KEY0, provider);

const usdc = new Contract(
  client.cctp.usdc,
  [
    "function mint(address to, uint256 amount)",
    "function addMinter(address minter)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function balanceOf(address) view returns (uint256)",
  ],
  deployer,
);
const pool = new Contract(
  client.contracts.privacyPoolClient,
  [
    "function crossChainShield(uint256 amount, uint256 maxFee, uint32 minFinalityThreshold, bytes32 npk, bytes32[3] encryptedBundle, bytes32 shieldKey, bytes32 destinationCaller, address integrator) returns (uint64)",
  ],
  deployer,
);

const amount = parseUnits("25", 6);
console.log("minting mock USDC to deployer on client A…");
try {
  await (await usdc.mint(deployer.address, amount)).wait();
} catch {
  await (await usdc.addMinter(deployer.address)).wait();
  await (await usdc.mint(deployer.address, amount)).wait();
}
await (await usdc.approve(client.contracts.privacyPoolClient, amount)).wait();

console.log("calling crossChainShield (client A → hub)…");
const npk = "0x" + "11".repeat(32);
const bundle = ["0x" + "22".repeat(32), "0x" + "33".repeat(32), "0x" + "44".repeat(32)];
const destinationCaller = process.env.BIND_CALLER === "1"
  ? zeroPadValue(hub.contracts.hookRouter, 32) // bound to our hub HookRouter
  : "0x" + "00".repeat(32); // zero = any relayer (the common user path)
const tx = await pool.crossChainShield(
  amount,
  amount / 10n, // maxFee — must be < amount
  2000, // minFinalityThreshold: finalized
  npk,
  bundle,
  "0x" + "55".repeat(32),
  destinationCaller,
  "0x" + "00".repeat(20), // integrator: none
);
const receipt = await tx.wait();
console.log(`crossChainShield mined: ${receipt.hash} (block ${receipt.blockNumber})`);

console.log("waiting for the actor to deliver (polling /cctp/delivered, destinationDomain=100)…");
const deadline = Date.now() + 120_000;
let delivered = null;
while (Date.now() < deadline && !delivered) {
  await new Promise((r) => setTimeout(r, 2000));
  try {
    const res = await fetch(`${ACTOR_URL}/cctp/delivered?destinationDomain=100&sinceMs=0`);
    const body = await res.json();
    delivered = (body.records ?? []).find((r) => r.sourceTxHash === receipt.hash) ?? null;
    process.stdout.write(".");
  } catch {
    process.stdout.write("x");
  }
}
console.log();
if (!delivered) {
  console.error("FAIL: message was not delivered within 120s");
  process.exit(1);
}
console.log("DELIVERED:", JSON.stringify(delivered, null, 2));

// exactly-once check: the destination tx exists and succeeded on the hub
const hubProvider = new JsonRpcProvider("http://127.0.0.1:8545", 31337, { staticNetwork: true });
const destReceipt = await hubProvider.getTransactionReceipt(delivered.destinationTxHash);
if (!destReceipt || destReceipt.status !== 1) {
  console.error("FAIL: destination tx missing or reverted");
  process.exit(1);
}
console.log(`destination tx confirmed on hub in block ${destReceipt.blockNumber}. E2E OK`);
