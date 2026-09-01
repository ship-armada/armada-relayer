// ABOUTME: Tests the interim @armada/sdk-native quick-sync serializer: raw hub logs → the SDK wire
// ABOUTME: shape, pinning encodings + parseQuickSync invariants, and hash-parity with the engine decode.
import { describe, it, expect, beforeAll } from "vitest";
import { encodeEventTopics, encodeAbiParameters } from "viem";
import { PrivacyPoolAbi } from "../abis/PrivacyPool";
import { initPoseidonWasm } from "../src/api/lib/poseidon";
import { decodeShieldCommitments, type RawLogRow } from "../src/api/lib/quick-sync-decode";
import {
  serializeNativeQuickSync,
  nativeShields,
  nativeTransacts,
  nativeNullifiers,
  nativeUnshields,
  NATIVE_QUICK_SYNC_SCHEMA_VERSION,
} from "../src/api/lib/quick-sync-native";

const TX = "0xCdEf" + "cd".repeat(30); // letters-bearing tx hash (exercises lowercasing)
const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"; // checksummed
const TO = "0x98b1CBa0908C98c95c9C87D94e4fCdddc87C933d"; // checksummed
const b32 = (n: string) => "0x" + n.repeat(32);

// Encode a raw log for the quick-sync events (all args non-indexed): topics=[sig], data=ABI-encoded args.
function row(eventName: string, args: Record<string, unknown>, over: Partial<RawLogRow> = {}): RawLogRow {
  const event = PrivacyPoolAbi.find((e) => e.type === "event" && e.name === eventName)!;
  const inputs = (event as { inputs: readonly { name: string }[] }).inputs;
  const topics = encodeEventTopics({ abi: PrivacyPoolAbi, eventName: eventName as never });
  const data = encodeAbiParameters(inputs, inputs.map((i) => args[i.name]) as never);
  return { blockNumber: 500n, txHash: TX, logIndex: 2, data, topics: topics as string[], ...over };
}

// Mirrors the load-bearing checks in @armada/sdk parseQuickSync so the watcher output can't drift out
// of what the SDK will accept (the definitive cross-repo check lands with the #26 migration).
function assertSdkParseable(body: ReturnType<typeof serializeNativeQuickSync>): void {
  expect(body.schemaVersion).toBe(NATIVE_QUICK_SYNC_SCHEMA_VERSION);
  expect(Number.isInteger(body.syncedThroughBlock) && body.syncedThroughBlock >= 0).toBe(true);
  for (const arr of [body.shields, body.transacts, body.nullifiers, body.unshields]) {
    expect(Array.isArray(arr)).toBe(true);
  }
  const decimal = (s: string) => expect(BigInt(s) >= 0n).toBe(true);
  const posOk = (p: number) => expect(Number.isInteger(p) && p >= 0 && p <= 65535).toBe(true);
  for (const s of body.shields) {
    posOk(s.position);
    decimal(s.value);
    decimal(s.tokenData.tokenSubID);
    if (s.fee !== undefined) decimal(s.fee);
    expect(s.encryptedBundle).toHaveLength(3);
  }
  for (const t of body.transacts) {
    posOk(t.position);
    expect(t.ciphertext.ciphertext).toHaveLength(4);
  }
  for (const n of body.nullifiers) decimal(n.nullifier);
  for (const u of body.unshields) {
    decimal(u.amount);
    decimal(u.fee);
    decimal(u.tokenData.tokenSubID);
  }
}

beforeAll(async () => {
  await initPoseidonWasm();
});

describe("nativeShields", () => {
  const shieldRow = () =>
    row("Shield", {
      treeNumber: 0,
      startPosition: 4,
      commitments: [
        { npk: b32("07"), token: { tokenType: 0, tokenAddress: USDC, tokenSubID: 0n }, value: 1_000_000n },
        { npk: b32("08"), token: { tokenType: 0, tokenAddress: USDC, tokenSubID: 9n }, value: 999n },
      ],
      shieldCiphertext: [
        { encryptedBundle: [b32("01"), b32("02"), b32("03")], shieldKey: b32("04") },
        { encryptedBundle: [b32("11"), b32("12"), b32("13")], shieldKey: b32("14") },
      ],
      fees: [2_500n, 0n],
    });

  it("emits the SDK wire shape: decimal value/subID, lowercase 0x token address, no-0x npk/bundle/key", () => {
    const [s0, s1] = nativeShields([shieldRow()]);
    expect(s0).toEqual({
      tree: 0,
      position: 4,
      blockNumber: 500,
      txid: TX.toLowerCase(),
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      npk: "07".repeat(32),
      tokenData: { tokenType: 0, tokenAddress: USDC.toLowerCase(), tokenSubID: "0" },
      value: "1000000",
      encryptedBundle: ["01".repeat(32), "02".repeat(32), "03".repeat(32)],
      shieldKey: "04".repeat(32),
      fee: "2500",
    });
    expect(s1!.position).toBe(5);
    expect(s1!.tokenData.tokenSubID).toBe("9");
    expect(s1!.value).toBe("999");
    // A zero fee is still emitted (the event carried a fees[] entry) — decimal "0", not omitted.
    expect(s1!.fee).toBe("0");
  });

  it("computes a leaf hash byte-identical to the ground-truthed engine shield decode", () => {
    const r = shieldRow();
    const engine = decodeShieldCommitments([r])[0]!.commitments; // hash = poseidon(npk, tokenHash, value), no-0x
    const native = nativeShields([r]);
    expect(native.map((s) => s.hash)).toEqual(engine.map((c) => c.hash));
  });

  it("refuses a non-ERC20 shield rather than emitting a silently-wrong hash", () => {
    const bad = row("Shield", {
      treeNumber: 0,
      startPosition: 0,
      commitments: [{ npk: b32("07"), token: { tokenType: 1, tokenAddress: USDC, tokenSubID: 5n }, value: 1n }],
      shieldCiphertext: [{ encryptedBundle: [b32("01"), b32("02"), b32("03")], shieldKey: b32("04") }],
      fees: [0n],
    });
    expect(() => nativeShields([bad])).toThrow(/unsupported shield tokenType 1/);
  });
});

describe("nativeTransacts", () => {
  const cc = () => ({
    ciphertext: [b32("a1"), b32("a2"), b32("a3"), b32("a4")], // bytes32[4]
    blindedSenderViewingKey: b32("b1"),
    blindedReceiverViewingKey: b32("b2"),
    annotationData: "0xdead",
    memo: "0xbeef",
  });

  it("emits the raw bytes32[4] ciphertext (no engine iv/tag split), no-0x hash/keys, incrementing position", () => {
    const rows = [
      row(
        "Transact",
        { treeNumber: 2, startPosition: 10, hash: [b32("11"), b32("22")], ciphertext: [cc(), cc()] },
        { blockNumber: 200n },
      ),
    ];
    const [t0, t1] = nativeTransacts(rows);
    expect(t0).toEqual({
      tree: 2,
      position: 10,
      blockNumber: 200,
      txid: TX.toLowerCase(),
      hash: "11".repeat(32),
      ciphertext: {
        ciphertext: ["a1".repeat(32), "a2".repeat(32), "a3".repeat(32), "a4".repeat(32)],
        blindedSenderViewingKey: "b1".repeat(32),
        blindedReceiverViewingKey: "b2".repeat(32),
        memo: "0xbeef",
        annotationData: "0xdead",
      },
    });
    expect(t1!.hash).toBe("22".repeat(32));
    expect(t1!.position).toBe(11);
  });
});

describe("nativeNullifiers", () => {
  it("expands the nullifier array into decimal-encoded rows, in order", () => {
    const n0 = b32("ff"); // 0xfff… (large) → decimal
    const rows = [row("Nullified", { treeNumber: 3, nullifier: [b32("11"), n0] })];
    const out = nativeNullifiers(rows);
    expect(out[0]).toEqual({
      tree: 3,
      nullifier: BigInt(b32("11")).toString(),
      blockNumber: 500,
      txid: TX.toLowerCase(),
    });
    expect(out[1]!.nullifier).toBe(BigInt(n0).toString());
  });
});

describe("nativeUnshields", () => {
  it("nests tokenData and decimal-encodes amount/fee", () => {
    const rows = [
      row("Unshield", {
        to: TO,
        token: { tokenType: 0, tokenAddress: USDC, tokenSubID: 7n },
        amount: 1_000_000n,
        fee: 2_500n,
      }),
    ];
    expect(nativeUnshields(rows)[0]).toEqual({
      to: TO,
      tokenData: { tokenType: 0, tokenAddress: USDC.toLowerCase(), tokenSubID: "7" },
      amount: "1000000",
      fee: "2500",
      blockNumber: 500,
      txid: TX.toLowerCase(),
    });
  });
});

describe("serializeNativeQuickSync envelope", () => {
  it("wraps a mixed batch in the versioned envelope and stays parseQuickSync-compatible", () => {
    const rows = [
      row("Shield", {
        treeNumber: 0,
        startPosition: 0,
        commitments: [{ npk: b32("07"), token: { tokenType: 0, tokenAddress: USDC, tokenSubID: 0n }, value: 5n }],
        shieldCiphertext: [{ encryptedBundle: [b32("01"), b32("02"), b32("03")], shieldKey: b32("04") }],
        fees: [1n],
      }),
      row("Nullified", { treeNumber: 0, nullifier: [b32("aa")] }, { logIndex: 3 }),
      row(
        "Unshield",
        { to: TO, token: { tokenType: 0, tokenAddress: USDC, tokenSubID: 0n }, amount: 1n, fee: 0n },
        { logIndex: 4 },
      ),
    ];
    const body = serializeNativeQuickSync(rows, 12345);
    expect(body.schemaVersion).toBe(1);
    expect(body.syncedThroughBlock).toBe(12345);
    expect(body.shields).toHaveLength(1);
    expect(body.nullifiers).toHaveLength(1);
    expect(body.unshields).toHaveLength(1);
    expect(body.transacts).toEqual([]);
    assertSdkParseable(body);
  });

  it("is empty (but well-formed) for a batch with no pool events", () => {
    const body = serializeNativeQuickSync([], 42);
    expect(body).toEqual({
      schemaVersion: 1,
      syncedThroughBlock: 42,
      shields: [],
      transacts: [],
      nullifiers: [],
      unshields: [],
    });
    assertSdkParseable(body);
  });
});
