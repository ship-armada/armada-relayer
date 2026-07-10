// ABOUTME: §15.3 v1/v2 parity suite: records the v1 relayer's responses across the public
// ABOUTME: surface, replays against v2, asserts status + body-shape + error-code compatibility.
// Usage:
//   npx tsx e2e/parity-replay.mts record   (against v1 on BASE_URL)
//   npx tsx e2e/parity-replay.mts replay   (against v2 on BASE_URL, compares to recording)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Interface } from "ethers";
import { TRANSACT_ABI } from "../src/relay/transact-shape.js";

const MODE = process.argv[2];
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3001";
const DEPLOYMENTS = process.env.DEPLOYMENTS_DIR;
const RECORDING = process.env.RECORDING ?? "/tmp/armada-parity-recording.json";
if (!DEPLOYMENTS || (MODE !== "record" && MODE !== "replay")) {
  throw new Error("usage: DEPLOYMENTS_DIR=… [BASE_URL=…] tsx e2e/parity-replay.mts record|replay");
}

const hub = JSON.parse(readFileSync(join(DEPLOYMENTS, "privacy-pool-hub.json"), "utf8"));
const POOL = hub.contracts.privacyPool as string;
const WRAPPER = hub.contracts.gaslessShieldWrapper as string;
const USDC = hub.cctp.usdc as string;
const TX66 = "0x" + "ab".repeat(32);

// --- calldata builders (real ABIs — exercise the decode path in BOTH services) ---
const GASLESS_IFACE = new Interface([
  "function gaslessShield(address user, uint256 totalAmount, uint256 fee, uint256 deadline, uint8 v, bytes32 r, bytes32 s, ((bytes32,(uint8,address,uint256),uint120),(bytes32[3],bytes32)) shieldRequest, address integrator)",
]);
const gaslessLowFee = GASLESS_IFACE.encodeFunctionData("gaslessShield", [
  "0x" + "11".repeat(20), 1000n, 1n, 9999999999n, 27, "0x" + "01".repeat(32), "0x" + "02".repeat(32),
  [["0x" + "03".repeat(32), [0, USDC, 0n], 500n],
   [["0x" + "04".repeat(32), "0x" + "05".repeat(32), "0x" + "06".repeat(32)], "0x" + "07".repeat(32)]],
  "0x" + "00".repeat(20),
]);
const transactJunk = new Interface([...TRANSACT_ABI]).encodeFunctionData("transact", [[{
  proof: { a: { x: 1n, y: 2n }, b: { x: [1n, 2n], y: [3n, 4n] }, c: { x: 5n, y: 6n } },
  merkleRoot: "0x" + "aa".repeat(32),
  nullifiers: ["0x" + "bb".repeat(32)],
  commitments: ["0x" + "cc".repeat(32)],
  boundParams: {
    treeNumber: 0, minGasPrice: 0n, unshield: 0, chainID: 31337n,
    adaptContract: "0x" + "00".repeat(20), adaptParams: "0x" + "00".repeat(32),
    commitmentCiphertext: [{
      ciphertext: ["0x" + "01".repeat(32), "0x" + "02".repeat(32), "0x" + "03".repeat(32), "0x" + "04".repeat(32)],
      blindedSenderViewingKey: "0x" + "05".repeat(32), blindedReceiverViewingKey: "0x" + "06".repeat(32),
      annotationData: "0x", memo: "0x",
    }],
  },
  unshieldPreimage: { npk: "0x" + "07".repeat(32), token: { tokenType: 0, tokenAddress: USDC, tokenSubID: 0n }, value: 100n },
}]]);

interface Case {
  name: string;
  method: "GET" | "POST";
  path: string;
  body?: (cacheId: string) => object;
  /** compare HTTP status only (documented v1→v2 differences, e.g. banner, /cctp-status) */
  statusOnly?: boolean;
  /** §16.1: endpoint intentionally removed in v2 — v1 404s with a body, v2 plain-404s */
  expectedDiff?: string;
}

const CASES: Case[] = [
  { name: "banner", method: "GET", path: "/", statusOnly: true, expectedDiff: "service name + endpoint list differ by design" },
  { name: "fees-hub", method: "GET", path: "/fees" },
  { name: "fees-client", method: "GET", path: "/fees?chainId=31338" },
  { name: "fees-unknown-chain", method: "GET", path: "/fees?chainId=999" },
  { name: "relay-missing-fields", method: "POST", path: "/relay", body: () => ({ chainId: 31337 }) },
  { name: "relay-bad-idempotency-key", method: "POST", path: "/relay", body: (c) => ({ chainId: 31337, to: POOL, data: "0x00", feesCacheId: c, idempotencyKey: "k".repeat(201) }) },
  { name: "relay-invalid-chain", method: "POST", path: "/relay", body: (c) => ({ chainId: 999, to: POOL, data: "0x00", feesCacheId: c }) },
  { name: "relay-invalid-target", method: "POST", path: "/relay", body: (c) => ({ chainId: 31337, to: "0x" + "99".repeat(20), data: "0x00", feesCacheId: c }) },
  { name: "relay-fee-expired", method: "POST", path: "/relay", body: () => ({ chainId: 31337, to: POOL, data: "0x00", feesCacheId: "fee-31337-1-1" }) },
  { name: "relay-short-data", method: "POST", path: "/relay", body: (c) => ({ chainId: 31337, to: POOL, data: "0x", feesCacheId: c }) },
  { name: "relay-bad-selector", method: "POST", path: "/relay", body: (c) => ({ chainId: 31337, to: POOL, data: "0xdeadbeef" + "00".repeat(32), feesCacheId: c }) },
  { name: "relay-gasless-low-fee", method: "POST", path: "/relay", body: (c) => ({ chainId: 31337, to: WRAPPER, data: gaslessLowFee, feesCacheId: c }) },
  { name: "relay-transact-unverifiable-fee", method: "POST", path: "/relay", body: (c) => ({ chainId: 31337, to: POOL, data: transactJunk, feesCacheId: c }) },
  { name: "status-malformed-hash", method: "GET", path: "/status/nothex" },
  { name: "status-bad-chainid", method: "GET", path: `/status/${TX66}?chainId=abc` },
  { name: "status-unknown-tx", method: "GET", path: `/status/${TX66}` },
  { name: "health", method: "GET", path: "/health" },
  { name: "cctp-status-removed", method: "GET", path: `/cctp-status/${TX66}`, statusOnly: true, expectedDiff: "§16.1: endpoint removed in v2; both 404" },
];

/** The /health `counters` field is a traffic-dependent Record<string, number> — its key set
 * reflects which events have occurred since boot (identical semantics in v1 and v2), so shape
 * comparison validates it as a numeric map rather than comparing key sets. */
function normalize(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    if (v.counters && typeof v.counters === "object") {
      const allNumbers = Object.values(v.counters as object).every((x) => typeof x === "number");
      return { ...v, counters: allNumbers ? "numeric-map" : v.counters };
    }
  }
  return value;
}

/** Recursive shape signature: objects → sorted key/shape map, arrays → element shape, else typeof. */
function shapeOf(value: unknown): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) return [value.length > 0 ? shapeOf(value[0]) : "empty"];
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as object).sort().map((k) => [k, shapeOf((value as Record<string, unknown>)[k])]),
    );
  }
  return typeof value;
}

async function hit(c: Case, cacheId: string) {
  const res = await fetch(`${BASE}${c.path}`, {
    method: c.method,
    headers: c.method === "POST" ? { "content-type": "application/json" } : {},
    body: c.body ? JSON.stringify(c.body(cacheId)) : undefined,
  });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* non-JSON (plain 404) */ }
  return { status: res.status, body };
}

const freshCacheId = async () =>
  ((await (await fetch(`${BASE}/fees`)).json()) as { cacheId: string }).cacheId;

if (MODE === "record") {
  const recording: Record<string, { status: number; body: unknown }> = {};
  for (const c of CASES) {
    recording[c.name] = await hit(c, await freshCacheId());
    console.log(`recorded ${c.name}: ${recording[c.name]!.status}`);
  }
  writeFileSync(RECORDING, JSON.stringify(recording, null, 2));
  console.log(`\nwrote ${RECORDING}`);
} else {
  const recording = JSON.parse(readFileSync(RECORDING, "utf8"));
  let failures = 0;
  for (const c of CASES) {
    const v1 = recording[c.name];
    if (!v1) { console.log(`SKIP ${c.name} (not recorded)`); continue; }
    const v2 = await hit(c, await freshCacheId());
    const problems: string[] = [];
    if (v1.status !== v2.status) problems.push(`status ${v1.status} → ${v2.status}`);
    if (!c.statusOnly) {
      const s1 = JSON.stringify(shapeOf(normalize(v1.body)));
      const s2 = JSON.stringify(shapeOf(normalize(v2.body)));
      if (s1 !== s2) problems.push(`shape ${s1} → ${s2}`);
      const code1 = (v1.body as { code?: string })?.code;
      const code2 = (v2.body as { code?: string })?.code;
      if (code1 !== code2) problems.push(`code ${code1} → ${code2}`);
      const st1 = (v1.body as { status?: string })?.status;
      const st2 = (v2.body as { status?: string })?.status;
      if (typeof st1 === "string" && st1 !== st2) problems.push(`body.status ${st1} → ${st2}`);
    }
    if (problems.length === 0) {
      console.log(`OK   ${c.name}${c.expectedDiff ? ` (status-only: ${c.expectedDiff})` : ""}`);
    } else {
      failures += 1;
      console.log(`FAIL ${c.name}: ${problems.join("; ")}`);
      console.log(`     v1: ${JSON.stringify(v1.body)?.slice(0, 200)}`);
      console.log(`     v2: ${JSON.stringify(v2.body)?.slice(0, 200)}`);
    }
  }
  if (failures > 0) { console.error(`\nPARITY FAILED: ${failures} case(s)`); process.exit(1); }
  console.log("\nPARITY PASSED: v2 is shape-compatible with the recorded v1 surface");
}
