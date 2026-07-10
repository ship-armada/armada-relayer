// ABOUTME: Ground-truth gate (spec §7.3 §4): asserts the watcher's shield/transact decoders
// ABOUTME: produce byte-identical output to @railgun-community/engine 9.5.1's own note formatters.
// Runs WITHOUT the live rig — the engine (devDependency) computes expected values from fixtures.
import { describe, it, expect, beforeAll } from "vitest";
import { encodeEventTopics, encodeAbiParameters } from "viem";
// Engine (devDependency, test-only) — the source of truth for hashes + serialization.
import { getNoteHash, serializePreImage, serializeTokenData } from "@railgun-community/engine";
import { PrivacyPoolAbi } from "../abis/PrivacyPool";
import { initPoseidonWasm } from "../src/lib/poseidon";
import { decodeShieldCommitments, formatUint256, type RawLogRow } from "../src/lib/quick-sync-decode";

const TX = "0x" + "cd".repeat(32);
const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"; // sepolia test USDC (checksummed)

function shieldRow(commitments: unknown[], shieldCiphertext: unknown[], fees: bigint[]): RawLogRow {
  const event = PrivacyPoolAbi.find((e) => e.type === "event" && e.name === "Shield")!;
  const inputs = (event as { inputs: readonly { name: string }[] }).inputs;
  const args: Record<string, unknown> = { treeNumber: 0, startPosition: 4, commitments, shieldCiphertext, fees };
  const topics = encodeEventTopics({ abi: PrivacyPoolAbi, eventName: "Shield" });
  const data = encodeAbiParameters(inputs, inputs.map((i) => args[i.name]) as never);
  return { blockNumber: 500n, txHash: TX, logIndex: 2, data, topics: topics as string[] };
}

beforeAll(async () => {
  await initPoseidonWasm(); // watcher poseidon; the engine self-inits its own on import
});

describe("shield hash ground truth vs engine 9.5.1", () => {
  it("computes the same commitment hash the engine does (ERC20, value AS-IS, no fee subtraction)", () => {
    const npk = "0x" + "07".repeat(32);
    const value = 1_000_000n;
    const fee = 2_500n; // fee-bearing shield — the case the buggy formula would break
    const commitments = [{ npk, token: { tokenType: 0, tokenAddress: USDC, tokenSubID: 0n }, value }];
    const shieldCiphertext = [{ encryptedBundle: ["0x" + "01".repeat(32), "0x" + "02".repeat(32), "0x" + "03".repeat(32)], shieldKey: "0x" + "04".repeat(32) }];

    const [ev] = decodeShieldCommitments([shieldRow(commitments, shieldCiphertext, [fee])]);
    const got = ev!.commitments[0]!;

    // Engine's expected hash: getNoteHash(npk, serializeTokenData(...), value) — value AS-IS.
    const tokenData = serializeTokenData(USDC, 0, "0");
    const expectedHash = getNoteHash(npk, tokenData, value); // bigint
    expect(got.hash).toBe(expectedHash.toString(16).padStart(64, "0"));

    // Engine's expected preImage serialization.
    const expectedPre = serializePreImage(npk, tokenData, value, false);
    if (got.commitmentType === "ShieldCommitment") {
      expect(got.preImage).toEqual(expectedPre);
      expect(got.fee).toBe("2500");
      expect(got.from).toBeUndefined();
      expect(got.txid).toBe(formatUint256(TX));
      expect(got).toMatchObject({ utxoTree: 0, utxoIndex: 4, timestamp: undefined });
    }
  });

  it("a ZERO fee serializes to undefined (engine truthiness), value still AS-IS", () => {
    const npk = "0x" + "aa".repeat(32);
    const value = 42n;
    const commitments = [{ npk, token: { tokenType: 0, tokenAddress: USDC, tokenSubID: 0n }, value }];
    const shieldCiphertext = [{ encryptedBundle: ["0x" + "0a".repeat(32), "0x" + "0b".repeat(32), "0x" + "0c".repeat(32)], shieldKey: "0x" + "0d".repeat(32) }];

    const [ev] = decodeShieldCommitments([shieldRow(commitments, shieldCiphertext, [0n])]);
    const got = ev!.commitments[0]!;
    const expectedHash = getNoteHash(npk, serializeTokenData(USDC, 0, "0"), value);
    expect(got.hash).toBe(expectedHash.toString(16).padStart(64, "0"));
    if (got.commitmentType === "ShieldCommitment") expect(got.fee).toBeUndefined();
  });
});
