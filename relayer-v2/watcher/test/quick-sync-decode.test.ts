// ABOUTME: Phase-2 decode tests: raw Nullified/Unshield logs → engine element shapes, via
// ABOUTME: viem round-trip (encode a log, decode it, assert). No live rig needed for decode logic.
import { describe, it, expect } from "vitest";
import { encodeEventTopics, encodeAbiParameters } from "viem";
import { PrivacyPoolAbi } from "../abis/PrivacyPool";
import {
  decodeNullifiers,
  decodeUnshields,
  decodeTransactCommitments,
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

describe("decodeTransactCommitments", () => {
  const b32 = (n: string) => "0x" + n.repeat(32);
  function cc(over: Partial<Record<string, unknown>> = {}) {
    return {
      ciphertext: [b32("a1"), b32("a2"), b32("a3"), b32("a4")], // bytes32[4]
      blindedSenderViewingKey: b32("b1"),
      blindedReceiverViewingKey: b32("b2"),
      annotationData: "0xdead",
      memo: "0xbeef",
      ...over,
    };
  }

  it("one CommitmentEvent per log; hash from event hash[]; ciphertext split matches the engine", () => {
    const rows = [
      row(
        "Transact",
        { treeNumber: 2, startPosition: 10, hash: [b32("11"), b32("22")], ciphertext: [cc(), cc()] },
        { blockNumber: 200n },
      ),
    ];
    const events = decodeTransactCommitments(rows);
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev).toMatchObject({ txid: formatUint256(TX), treeNumber: 2, startPosition: 10, blockNumber: 200 });
    expect(ev.commitments).toHaveLength(2);
    const c0 = ev.commitments[0]!;
    expect(c0.commitmentType).toBe("TransactCommitmentV2");
    expect(c0.hash).toBe("11".repeat(32));
    expect(c0).toMatchObject({ utxoTree: 2, utxoIndex: 10, railgunTxid: undefined, timestamp: undefined });
    // ivTag = ciphertext[0] (a1×32 = 64 chars); iv=first 32 hex, tag=last 32, data=remaining 3
    expect(c0.commitmentType === "TransactCommitmentV2" && c0.ciphertext.ciphertext).toEqual({
      iv: "a1".repeat(16),
      tag: "a1".repeat(16),
      data: ["a2".repeat(32), "a3".repeat(32), "a4".repeat(32)],
    });
    if (c0.commitmentType === "TransactCommitmentV2") {
      expect(c0.ciphertext.blindedSenderViewingKey).toBe("b1".repeat(32));
      expect(c0.ciphertext.annotationData).toBe("0xdead");
      expect(c0.ciphertext.memo).toBe("0xbeef");
    }
    // second commitment: hash[1], utxoIndex incremented
    expect(ev.commitments[1]!.hash).toBe("22".repeat(32));
    expect(ev.commitments[1]!.utxoIndex).toBe(11);
  });

  it("ignores non-Transact logs", () => {
    const rows = [row("Nullified", { treeNumber: 0, nullifier: [b32("aa")] })];
    expect(decodeTransactCommitments(rows)).toEqual([]);
  });
});
