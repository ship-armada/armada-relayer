// ABOUTME: Ground-truth gate (spec §7.3 §4): asserts EVERY watcher decoder (shield, transact,
// ABOUTME: nullifier, unshield) is byte-identical to @railgun-community/engine 9.5.1's own scan-path
// formatters (V2Events.*), computed from the same raw logs. Runs WITHOUT the live rig — the engine
// is a devDependency. Addresses are letters-bearing (EIP-55) to exercise viem/ethers casing parity.
import { describe, it, expect, beforeAll } from "vitest";
import { encodeEventTopics, encodeAbiParameters, decodeEventLog } from "viem";
// Engine (devDependency, test-only): V2Events are the exact scan-path formatters; getNoteHash the hash source.
import { V2Events } from "@railgun-community/engine";
import { PrivacyPoolAbi } from "../abis/PrivacyPool";
import { initPoseidonWasm } from "../src/lib/poseidon";
import {
  decodeShieldCommitments,
  decodeTransactCommitments,
  decodeNullifiers,
  decodeUnshields,
  type RawLogRow,
} from "../src/lib/quick-sync-decode";

const TX = "0xCdEf" + "cd".repeat(30); // letters-bearing tx hash
const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"; // letters-bearing (checksummed)
const TO = "0x98b1CBa0908C98c95c9C87D94e4fCdddc87C933d"; // letters-bearing, valid EIP-55 checksum
const BLOCK = 500n;
const LOG_INDEX = 2;

// Encode a raw log for the quick-sync events (all args non-indexed): topics=[sig], data=ABI-encoded args.
function row(eventName: string, args: Record<string, unknown>): { row: RawLogRow; args: Record<string, unknown> } {
  const event = PrivacyPoolAbi.find((e) => e.type === "event" && e.name === eventName)!;
  const inputs = (event as { inputs: readonly { name: string }[] }).inputs;
  const topics = encodeEventTopics({ abi: PrivacyPoolAbi, eventName: eventName as never });
  const data = encodeAbiParameters(inputs, inputs.map((i) => args[i.name]) as never);
  const r: RawLogRow = { blockNumber: BLOCK, txHash: TX, logIndex: LOG_INDEX, data, topics: topics as string[] };
  // Decoded args as viem produces them — the same input the engine formatter receives.
  const decoded = decodeEventLog({ abi: PrivacyPoolAbi, data, topics: topics as never });
  return { row: r, args: decoded.args as unknown as Record<string, unknown> };
}

const b32 = (n: string) => "0x" + n.repeat(32);

beforeAll(async () => {
  await initPoseidonWasm(); // watcher poseidon; the engine self-inits its own on import
});

describe("ground truth vs engine 9.5.1 V2Events (all four decoders, same raw logs)", () => {
  it("shield: decodeShieldCommitments === V2Events.formatShieldEvent (fee-bearing ERC20)", () => {
    const commitments = [
      { npk: b32("07"), token: { tokenType: 0, tokenAddress: USDC, tokenSubID: 0n }, value: 1_000_000n },
      { npk: b32("08"), token: { tokenType: 0, tokenAddress: USDC, tokenSubID: 0n }, value: 999n },
    ];
    const shieldCiphertext = [
      { encryptedBundle: [b32("01"), b32("02"), b32("03")], shieldKey: b32("04") },
      { encryptedBundle: [b32("11"), b32("12"), b32("13")], shieldKey: b32("14") },
    ];
    const fees = [2_500n, 0n]; // one fee-bearing (value AS-IS), one zero (→ fee undefined)
    const { row: r, args } = row("Shield", { treeNumber: 0, startPosition: 4, commitments, shieldCiphertext, fees });

    const expected = V2Events.formatShieldEvent(args as never, TX, Number(BLOCK), fees as never, undefined);
    expect(decodeShieldCommitments([r])[0]).toEqual(expected);
  });

  it("transact: decodeTransactCommitments === V2Events.formatTransactEvent", () => {
    const cipher = () => ({
      ciphertext: [b32("a1"), b32("a2"), b32("a3"), b32("a4")],
      blindedSenderViewingKey: b32("b1"),
      blindedReceiverViewingKey: b32("b2"),
      annotationData: "0xdead",
      memo: "0xbeef",
    });
    const { row: r, args } = row("Transact", {
      treeNumber: 2,
      startPosition: 10,
      hash: [b32("11"), b32("22")],
      ciphertext: [cipher(), cipher()],
    });
    const expected = V2Events.formatTransactEvent(args as never, TX, Number(BLOCK), undefined);
    expect(decodeTransactCommitments([r])[0]).toEqual(expected);
  });

  it("nullifier: decodeNullifiers === V2Events.formatNullifiedEvents", () => {
    const { row: r, args } = row("Nullified", { treeNumber: 3, nullifier: [b32("11"), b32("22")] });
    const expected = V2Events.formatNullifiedEvents(args as never, TX, Number(BLOCK));
    expect(decodeNullifiers([r])).toEqual(expected);
  });

  it("unshield: decodeUnshields === V2Events.formatUnshieldEvent (eventLogIndex from logIndex)", () => {
    const { row: r, args } = row("Unshield", {
      to: TO,
      token: { tokenType: 0, tokenAddress: USDC, tokenSubID: 0n },
      amount: 1_000_000n,
      fee: 2_500n,
    });
    const expected = V2Events.formatUnshieldEvent(args as never, TX, Number(BLOCK), LOG_INDEX, undefined);
    expect(decodeUnshields([r])[0]).toEqual(expected);
  });
});
