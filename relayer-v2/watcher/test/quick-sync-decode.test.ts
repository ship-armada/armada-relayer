// ABOUTME: Phase-2 decode tests: raw Nullified/Unshield logs → engine element shapes, via
// ABOUTME: viem round-trip (encode a log, decode it, assert). No live rig needed for decode logic.
import { describe, it, expect } from "vitest";
import { encodeEventTopics, encodeAbiParameters } from "viem";
import { PrivacyPoolAbi } from "../abis/PrivacyPool";
import {
  decodeNullifiers,
  decodeUnshields,
  formatUint256,
  type RawLogRow,
} from "../src/lib/quick-sync-decode";

const TX = "0xabc0000000000000000000000000000000000000000000000000000000000001";

// Encode a raw log for the quick-sync events, whose args are ALL non-indexed:
// topics = [signature], data = ABI-encoded args in declaration order.
function row(eventName: string, args: Record<string, unknown>, over: Partial<RawLogRow> = {}): RawLogRow {
  const event = PrivacyPoolAbi.find((e) => e.type === "event" && e.name === eventName)!;
  const inputs = (event as { inputs: readonly { name: string }[] }).inputs;
  const topics = encodeEventTopics({ abi: PrivacyPoolAbi, eventName: eventName as never });
  const data = encodeAbiParameters(inputs, inputs.map((i) => args[i.name]) as never);
  return { blockNumber: 100n, txHash: TX, logIndex: 0, data, topics: topics as string[], ...over };
}

describe("formatUint256 (engine UINT_256 encoding)", () => {
  it("strips 0x, lowercases, left-pads to 64 chars", () => {
    expect(formatUint256("0xABCD")).toBe("abcd".padStart(64, "0"));
    expect(formatUint256(TX)).toBe(TX.slice(2).toLowerCase());
    expect(formatUint256(TX)).toHaveLength(64);
  });
});

describe("decodeNullifiers", () => {
  it("expands the nullifier array into one row each, in order, UINT_256-formatted", () => {
    const n0 = "0x" + "11".repeat(32);
    const n1 = "0x" + "22".repeat(32);
    const rows = [row("Nullified", { treeNumber: 3, nullifier: [n0, n1] })];
    expect(decodeNullifiers(rows)).toEqual([
      { nullifier: "11".repeat(32), treeNumber: 3, txid: formatUint256(TX), blockNumber: 100 },
      { nullifier: "22".repeat(32), treeNumber: 3, txid: formatUint256(TX), blockNumber: 100 },
    ]);
  });

  it("preserves cross-event order (block/log ordering is the caller's)", () => {
    const rows = [
      row("Nullified", { treeNumber: 0, nullifier: ["0x" + "aa".repeat(32)] }, { blockNumber: 100n, logIndex: 1 }),
      row("Nullified", { treeNumber: 0, nullifier: ["0x" + "bb".repeat(32)] }, { blockNumber: 101n, logIndex: 0 }),
    ];
    expect(decodeNullifiers(rows).map((n) => n.nullifier)).toEqual(["aa".repeat(32), "bb".repeat(32)]);
  });

  it("ignores non-Nullified logs", () => {
    const rows = [row("Unshield", { to: "0x" + "11".repeat(20), token: { tokenType: 0, tokenAddress: "0x" + "22".repeat(20), tokenSubID: 0n }, amount: 1n, fee: 0n })];
    expect(decodeNullifiers(rows)).toEqual([]);
  });
});

describe("decodeUnshields", () => {
  const TOKEN = "0x" + "22".repeat(20);
  const TO = "0x" + "33".repeat(20);

  it("maps token/amount/fee and sets eventLogIndex from the stored logIndex", () => {
    const rows = [
      row(
        "Unshield",
        { to: TO, token: { tokenType: 0, tokenAddress: TOKEN, tokenSubID: 7n }, amount: 1000000n, fee: 2500n },
        { logIndex: 5 },
      ),
    ];
    const [u] = decodeUnshields(rows);
    expect(u).toEqual({
      txid: formatUint256(TX),
      timestamp: undefined,
      toAddress: TO,
      tokenType: 0,
      tokenAddress: TOKEN,
      tokenSubID: "7",
      amount: "1000000",
      fee: "2500",
      blockNumber: 100,
      eventLogIndex: 5,
      railgunTxid: undefined,
      poisPerList: undefined,
    });
    // All Optional keys are present (deep-equal with the engine requires the keys, §3).
    expect(Object.keys(u!)).toEqual(
      expect.arrayContaining(["timestamp", "eventLogIndex", "railgunTxid", "poisPerList"]),
    );
  });

  it("ignores non-Unshield logs", () => {
    const rows = [row("Nullified", { treeNumber: 0, nullifier: ["0x" + "aa".repeat(32)] })];
    expect(decodeUnshields(rows)).toEqual([]);
  });
});
