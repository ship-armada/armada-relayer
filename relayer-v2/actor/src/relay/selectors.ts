// ABOUTME: Allowed calldata selectors (§6.2 step 4) and the wrapper-calldata decoding rules.
// ABOUTME: DEV-4: gasless/wrapper signatures are ASSUMED (wrapper ABIs unavailable here) — fix here only.
import { Interface, dataSlice } from "ethers";

// Explicit selectors given normatively in spec §6.2.
export const SELECTOR_TRANSACT = "0xd8ae136a";
export const SELECTOR_LEND_AND_SHIELD = "0xf2987ad1";
export const SELECTOR_REDEEM_AND_SHIELD = "0x0793b70e";
export const SELECTOR_ATOMIC_XCHAIN_UNSHIELD = "0xe484d408";

// ASSUMED wrapper function signatures (DEV-4). The spec pins only the semantics:
// gaslessShield's plaintext fee is argument index 2; gaslessCrossChainShield's fee is
// permitInput[2]. Regenerate from real wrapper ABIs and diff before cutover.
const GASLESS_IFACE = new Interface([
  "function gaslessShield(bytes shieldRequest, address token, uint256 fee, bytes permit)",
  "function gaslessCrossChainShield(bytes shieldRequest, uint32 destinationDomain, (uint256 amount, uint256 deadline, uint256 fee) permitInput, bytes permit)",
]);

export const SELECTOR_GASLESS_SHIELD = GASLESS_IFACE.getFunction("gaslessShield")!.selector;
export const SELECTOR_GASLESS_XCHAIN_SHIELD =
  GASLESS_IFACE.getFunction("gaslessCrossChainShield")!.selector;

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

export function selectorOf(data: string): string | null {
  if (typeof data !== "string" || !data.startsWith("0x") || data.length < 10) return null;
  return dataSlice(data, 0, 4).toLowerCase();
}

/** FeeSchedule key whose advertised fee applies to a selector (§6.1/§6.2). Only the
 * `transact → min(transfer, unshield)` rule is spec-explicit; the rest are inferred
 * from operation kind (DEV-1 note in .context/deviations.md). */
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
      return ["transfer", "unshield"]; // min() of these two
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
      throw new Error(`no advertised fee mapping for selector ${selector}`);
  }
}

/** Decodes the plaintext gasless fee (§6.2.5 gasless path). Throws on any decode failure. */
export function decodeGaslessFee(selector: string, data: string): bigint {
  if (selector === SELECTOR_GASLESS_SHIELD) {
    const args = GASLESS_IFACE.decodeFunctionData("gaslessShield", data);
    return BigInt(args[2]);
  }
  if (selector === SELECTOR_GASLESS_XCHAIN_SHIELD) {
    const args = GASLESS_IFACE.decodeFunctionData("gaslessCrossChainShield", data);
    return BigInt(args[2].fee);
  }
  throw new Error(`not a gasless selector: ${selector}`);
}

/**
 * Normalizes proof-bearing wrapper calldata to a synthetic `transact` payload for the
 * broadcaster fee verifier (§6.2.5). `transact` passes through unchanged; wrapper
 * selectors are ASSUMED (DEV-4) to carry the inner transact calldata as their first
 * `bytes` argument. Throws (=> fail closed) when the shape doesn't hold.
 */
const WRAPPER_INNER_IFACE = new Interface([
  "function lendAndShield(bytes transactData, bytes extra)",
  "function redeemAndShield(bytes transactData, bytes extra)",
  "function atomicCrossChainUnshield(bytes transactData, bytes extra)",
]);

export function normalizeToSyntheticTransact(selector: string, data: string): string {
  if (selector === SELECTOR_TRANSACT) return data;
  if (!PROOF_BEARING_SELECTORS.has(selector)) {
    throw new Error(`selector ${selector} is not proof-bearing`);
  }
  // ABI layout of (bytes, ...) puts the first dynamic arg's offset first; decoding with a
  // generic (bytes,bytes) fragment recovers arg 0 regardless of trailing args.
  const inner = WRAPPER_INNER_IFACE.getAbiCoder().decode(
    ["bytes"],
    dataSlice(data, 4),
    true, // loose: ignore trailing data beyond the first arg's encoding
  )[0] as string;
  if (selectorOf(inner) !== SELECTOR_TRANSACT) {
    throw new Error("wrapper calldata does not embed a transact payload at arg 0");
  }
  return inner;
}
