// ABOUTME: Allowed calldata selectors (§6.2 step 4) and gasless fee decoding — signatures
// ABOUTME: reconciled against contracts/GaslessShieldWrapper*.sol and v1 gasless-fee-verifier.ts.
import { Interface, dataSlice, id as ethersId } from "ethers";
import {
  TRANSACT_SELECTOR,
  LEND_AND_SHIELD_SELECTOR,
  REDEEM_AND_SHIELD_SELECTOR,
  ATOMIC_CROSS_CHAIN_UNSHIELD_SELECTOR,
} from "./transact-shape.js";

export const SELECTOR_TRANSACT = TRANSACT_SELECTOR;
export const SELECTOR_LEND_AND_SHIELD = LEND_AND_SHIELD_SELECTOR;
export const SELECTOR_REDEEM_AND_SHIELD = REDEEM_AND_SHIELD_SELECTOR;
export const SELECTOR_ATOMIC_XCHAIN_UNSHIELD = ATOMIC_CROSS_CHAIN_UNSHIELD_SELECTOR;

// Selectors derived from the canonical signatures exactly as v1 does
// (relayer/modules/gasless-fee-verifier.ts). gaslessShield lives on the hub
// GaslessShieldWrapper; gaslessCrossChainShield on the client GaslessShieldWrapperClient.
export const SELECTOR_GASLESS_SHIELD = ethersId(
  "gaslessShield(address,uint256,uint256,uint256,uint8,bytes32,bytes32,((bytes32,(uint8,address,uint256),uint120),(bytes32[3],bytes32)),address)",
).slice(0, 10); // 0x1de05794

export const SELECTOR_GASLESS_XCHAIN_SHIELD = ethersId(
  "gaslessCrossChainShield((address,uint256,uint256,uint256,uint8,bytes32,bytes32),(uint256,uint32,bytes32,bytes32[3],bytes32,bytes32,address))",
).slice(0, 10); // 0xa608b736

// ABI fragments ported from v1 gasless-fee-verifier.ts:50-56 (match the Solidity structs in
// GaslessShieldWrapper.sol / GaslessShieldWrapperClient.sol).
const GASLESS_IFACE = new Interface([
  "function gaslessShield(address user, uint256 totalAmount, uint256 fee, uint256 deadline, uint8 v, bytes32 r, bytes32 s, ((bytes32,(uint8,address,uint256),uint120),(bytes32[3],bytes32)) shieldRequest, address integrator)",
  "function gaslessCrossChainShield((address user, uint256 totalAmount, uint256 fee, uint256 deadline, uint8 v, bytes32 r, bytes32 s) permitInput, (uint256 maxFee, uint32 minFinalityThreshold, bytes32 npk, bytes32[3] encryptedBundle, bytes32 shieldKey, bytes32 destinationCaller, address integrator) dest)",
]);

export const PROOF_BEARING_SELECTORS: ReadonlySet<string> = new Set([
  SELECTOR_TRANSACT,
  SELECTOR_LEND_AND_SHIELD,
  SELECTOR_REDEEM_AND_SHIELD,
  SELECTOR_ATOMIC_XCHAIN_UNSHIELD,
]);

export const GASLESS_SELECTORS: ReadonlySet<string> = new Set([
  SELECTOR_GASLESS_SHIELD,
  SELECTOR_GASLESS_XCHAIN_SHIELD,
]);

export const ALLOWED_SELECTORS: ReadonlySet<string> = new Set([
  ...PROOF_BEARING_SELECTORS,
  ...GASLESS_SELECTORS,
]);

/** Human-readable selector names, mirroring v1 privacy-relay.ts ALLOWED_SELECTORS —
 * used in counters keys (submitSuccess.<name>). */
export const SELECTOR_NAMES: ReadonlyMap<string, string> = new Map([
  [SELECTOR_TRANSACT, "transact"],
  [SELECTOR_LEND_AND_SHIELD, "lendAndShield"],
  [SELECTOR_REDEEM_AND_SHIELD, "redeemAndShield"],
  [SELECTOR_ATOMIC_XCHAIN_UNSHIELD, "atomicCrossChainUnshield"],
  [SELECTOR_GASLESS_SHIELD, "gaslessShield"],
  [SELECTOR_GASLESS_XCHAIN_SHIELD, "gaslessCrossChainShield"],
]);

export function selectorOf(data: string): string | null {
  if (typeof data !== "string" || !data.startsWith("0x") || data.length < 10) return null;
  return dataSlice(data, 0, 4).toLowerCase();
}

/** FeeSchedule key(s) a selector quotes under — v1 advertisedFeeForSelector mapping
 * (privacy-relay.ts:80-114): min() applies only to vanilla transact. */
export type FeeKey =
  | "transfer"
  | "unshield"
  | "crossContract"
  | "crossChainShield"
  | "crossChainUnshield"
  | "shield"
  | "shieldXchain";

export function advertisedFeeKeys(selector: string): FeeKey[] {
  switch (selector) {
    case SELECTOR_TRANSACT:
      return ["transfer", "unshield"]; // min(transfer, unshield)
    case SELECTOR_LEND_AND_SHIELD:
    case SELECTOR_REDEEM_AND_SHIELD:
      return ["crossContract"];
    case SELECTOR_ATOMIC_XCHAIN_UNSHIELD:
      return ["crossChainUnshield"];
    case SELECTOR_GASLESS_SHIELD:
      return ["shield"];
    case SELECTOR_GASLESS_XCHAIN_SHIELD:
      return ["shieldXchain"];
    default:
      throw new Error(`No advertised-fee mapping for selector ${selector}.`);
  }
}

/** Decodes the plaintext gasless fee: gaslessShield arg index 2; gaslessCrossChainShield
 * permitInput[2] (v1 gasless-fee-verifier.ts:122-136). Throws on any decode failure. */
export function decodeGaslessFee(selector: string, data: string): bigint {
  if (selector === SELECTOR_GASLESS_SHIELD) {
    const decoded = GASLESS_IFACE.decodeFunctionData("gaslessShield", data);
    // Args: [user, totalAmount, fee, deadline, v, r, s, shieldRequest, integrator]
    return BigInt(decoded[2]);
  }
  if (selector === SELECTOR_GASLESS_XCHAIN_SHIELD) {
    const decoded = GASLESS_IFACE.decodeFunctionData("gaslessCrossChainShield", data);
    const permitInput = decoded[0];
    return BigInt(permitInput[2]);
  }
  throw new Error(`not a gasless selector: ${selector}`);
}
