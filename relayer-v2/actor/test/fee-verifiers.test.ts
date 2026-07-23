// ABOUTME: Unit tests for the npk-reconstruction fee verifiers — redeemAndShield (#312) and the
// ABOUTME: permissionless gasless wrappers: fee note must be addressed to the relayer at >= advertised.
import { describe, it, expect } from "vitest";
import { Interface, toBeHex } from "ethers";
import { verifyRedeemFee } from "../src/relay/redeem-fee-verifier.js";
import { verifyGaslessFee } from "../src/relay/gasless-fee-verifier.js";
import { REDEEM_AND_SHIELD_ABI } from "../src/relay/transact-shape.js";
import { RelayError } from "../src/http/errors.js";

const USDC = "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9";
const WRAPPER = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";

// The npk the (stubbed) deriver reconstructs from feeShieldRandom — a fee note carrying this npk is
// "addressed to the relayer". A different npk models a note addressed to someone else.
const FEE_NPK = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdefn;
const FEE_NPK_HEX = toBeHex(FEE_NPK, 32);
const OTHER_NPK_HEX = toBeHex(0xdeadn, 32);
const RANDOM = "0x" + "ab".repeat(16);
const deriver = { deriveFeeNoteNpk: () => FEE_NPK };

/** A minimal-but-valid Railgun Transaction struct for redeem calldata encoding. */
const TX_STRUCT = {
  proof: { a: { x: 1n, y: 2n }, b: { x: [1n, 2n], y: [3n, 4n] }, c: { x: 5n, y: 6n } },
  merkleRoot: "0x" + "aa".repeat(32),
  nullifiers: ["0x" + "bb".repeat(32)],
  commitments: ["0x" + "cc".repeat(32)],
  boundParams: {
    treeNumber: 0,
    minGasPrice: 0n,
    unshield: 0,
    chainID: 31337n,
    adaptContract: "0x" + "00".repeat(20),
    adaptParams: "0x" + "00".repeat(32),
    commitmentCiphertext: [],
  },
  unshieldPreimage: {
    npk: "0x" + "07".repeat(32),
    token: { tokenType: 0, tokenAddress: USDC, tokenSubID: 0n },
    value: 100n,
  },
};

const CIPHER = [["0x" + "01".repeat(32), "0x" + "02".repeat(32), "0x" + "03".repeat(32)], "0x" + "04".repeat(32)];
const REDEEM_IFACE = new Interface([...REDEEM_AND_SHIELD_ABI]);

function redeemCalldata(feeNpkHex: string, feeAmount: bigint): string {
  return REDEEM_IFACE.encodeFunctionData("redeemAndShield", [
    TX_STRUCT,
    "0x" + "07".repeat(32), // _npk
    CIPHER, // _shieldCiphertext
    feeNpkHex, // _feeNpk
    CIPHER, // _feeShieldCiphertext
    feeAmount, // _feeAmount
  ]);
}

const GASLESS_SHIELD_IFACE = new Interface([
  "function gaslessShield((address user,uint256 deadline,uint256 nonce,address integrator,uint8 permitV,bytes32 permitR,bytes32 permitS) params, bytes intentSig, ((bytes32 npk,(uint8 tokenType,address tokenAddress,uint256 tokenSubID) token,uint120 value) preimage,(bytes32[3] encryptedBundle,bytes32 shieldKey) ciphertext)[] shieldRequests)",
]);
const GASLESS_XCHAIN_IFACE = new Interface([
  "function gaslessCrossChainShield((address user,uint256 deadline,uint256 nonce,uint256 maxFee,uint32 minFinalityThreshold,uint8 permitV,bytes32 permitR,bytes32 permitS) params, bytes intentSig, (bytes32 npk,uint120 value,bytes32[3] encryptedBundle,bytes32 shieldKey,address integrator) userNote, (bytes32 npk,uint120 value,bytes32[3] encryptedBundle,bytes32 shieldKey,address integrator) feeNote)",
]);

/** gaslessShield with a user note (not ours) followed by a fee note at `feeNpkHex`/`feeValue`. */
function gaslessShieldCalldata(feeNpkHex: string, feeValue: bigint): string {
  return GASLESS_SHIELD_IFACE.encodeFunctionData("gaslessShield", [
    ["0x" + "11".repeat(20), 9999n, 1n, "0x" + "09".repeat(20), 27, "0x" + "01".repeat(32), "0x" + "02".repeat(32)],
    "0x" + "cc".repeat(65),
    [
      [["0x" + "03".repeat(32), [0, USDC, 0n], 500n], CIPHER], // user note (not ours)
      [[feeNpkHex, [0, USDC, 0n], feeValue], CIPHER], // fee note
    ],
  ]);
}

function gaslessXchainCalldata(feeNpkHex: string, feeValue: bigint): string {
  const note = (npk: string, value: bigint) => [
    npk,
    value,
    ["0x" + "01".repeat(32), "0x" + "02".repeat(32), "0x" + "03".repeat(32)],
    "0x" + "04".repeat(32),
    "0x" + "00".repeat(20),
  ];
  return GASLESS_XCHAIN_IFACE.encodeFunctionData("gaslessCrossChainShield", [
    ["0x" + "11".repeat(20), 9999n, 1n, 50n, 1000, 27, "0x" + "01".repeat(32), "0x" + "02".repeat(32)],
    "0x" + "cc".repeat(65),
    note("0x" + "03".repeat(32), 500n), // userNote (not ours)
    note(feeNpkHex, feeValue), // feeNote
  ]);
}

/** Synchronous: the verifiers throw synchronously, so assertions must run in-line (not floated). */
function expectCode(fn: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(RelayError);
  expect((thrown as RelayError).code).toBe(code);
}

describe("verifyRedeemFee (#312 npk-reconstruction)", () => {
  it("accepts a fee note addressed to us at >= advertised and returns the fee", () => {
    const fee = verifyRedeemFee({ deriver }, { data: redeemCalldata(FEE_NPK_HEX, 1_000n) }, 1_000n, RANDOM);
    expect(fee).toBe(1_000n);
  });

  it("requires feeShieldRandom", () => {
    expect(() =>
      verifyRedeemFee({ deriver }, { data: redeemCalldata(FEE_NPK_HEX, 1_000n) }, 1_000n, undefined),
    ).toThrow(/feeShieldRandom/);
  });

  it("rejects a fee below advertised (FEE_INSUFFICIENT)", () => {
    expectCode(
      () => verifyRedeemFee({ deriver }, { data: redeemCalldata(FEE_NPK_HEX, 999n) }, 1_000n, RANDOM),
      "FEE_INSUFFICIENT",
    );
  });

  it("rejects a fee note addressed to someone else (FEE_INSUFFICIENT)", () => {
    expectCode(
      () => verifyRedeemFee({ deriver }, { data: redeemCalldata(OTHER_NPK_HEX, 1_000n) }, 1_000n, RANDOM),
      "FEE_INSUFFICIENT",
    );
  });

  it("rejects undecodable calldata (INVALID_DATA)", () => {
    expectCode(() => verifyRedeemFee({ deriver }, { data: "0xdeadbeef" }, 1_000n, RANDOM), "INVALID_DATA");
  });
});

describe("verifyGaslessFee (permissionless npk-reconstruction)", () => {
  const ctx = { wrappersByChain: new Map([[31337, WRAPPER]]), deriver };
  const req = (data: string) => ({ chainId: 31337, to: WRAPPER, data });

  it("accepts the hub shieldRequests fee note addressed to us", () => {
    expect(() =>
      verifyGaslessFee(ctx, req(gaslessShieldCalldata(FEE_NPK_HEX, 1_000n)), 1_000n, RANDOM),
    ).not.toThrow();
  });

  it("accepts the client feeNote addressed to us", () => {
    expect(() =>
      verifyGaslessFee(ctx, req(gaslessXchainCalldata(FEE_NPK_HEX, 1_000n)), 1_000n, RANDOM),
    ).not.toThrow();
  });

  it("rejects the wrong wrapper target (INVALID_TARGET)", () => {
    expectCode(
      () =>
        verifyGaslessFee(
          ctx,
          { chainId: 31337, to: USDC, data: gaslessShieldCalldata(FEE_NPK_HEX, 1_000n) },
          1_000n,
          RANDOM,
        ),
      "INVALID_TARGET",
    );
  });

  it("requires feeShieldRandom", () => {
    expectCode(
      () => verifyGaslessFee(ctx, req(gaslessShieldCalldata(FEE_NPK_HEX, 1_000n)), 1_000n, undefined),
      "INVALID_DATA",
    );
  });

  it("rejects when no note is addressed to us (FEE_INSUFFICIENT)", () => {
    expectCode(
      () => verifyGaslessFee(ctx, req(gaslessShieldCalldata(OTHER_NPK_HEX, 1_000n)), 1_000n, RANDOM),
      "FEE_INSUFFICIENT",
    );
  });

  it("rejects our fee note below advertised (FEE_INSUFFICIENT)", () => {
    expectCode(
      () => verifyGaslessFee(ctx, req(gaslessShieldCalldata(FEE_NPK_HEX, 999n)), 1_000n, RANDOM),
      "FEE_INSUFFICIENT",
    );
  });
});
