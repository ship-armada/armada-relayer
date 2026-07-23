// ABOUTME: Allowed calldata selectors (§6.2 step 4) + the advertised-fee map. Selectors are derived
// ABOUTME: from the canonical signatures; gasless calldata decoding lives in gasless-fee-verifier.ts.
import { dataSlice, id as ethersId } from "ethers";
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

// Gasless selectors derived from the permissionless (Phase C) wrapper signatures: both wrappers now
// take `(params, intentSig, …shielded notes)` — the relayer fee is a shielded note addressed to the
// relayer's 0zk, not a public-USDC transferFrom. gaslessShield lives on the hub GaslessShieldWrapper;
// gaslessCrossChainShield on the client GaslessShieldWrapperClient. Decode + npk-matching against
// these shapes lives in gasless-fee-verifier.ts.
export const SELECTOR_GASLESS_SHIELD = ethersId(
  "gaslessShield((address,uint256,uint256,address,uint8,bytes32,bytes32),bytes,((bytes32,(uint8,address,uint256),uint120),(bytes32[3],bytes32))[])",
).slice(0, 10); // 0x6e53fbcb

export const SELECTOR_GASLESS_XCHAIN_SHIELD = ethersId(
  "gaslessCrossChainShield((address,uint256,uint256,uint256,uint32,uint8,bytes32,bytes32),bytes,(bytes32,uint120,bytes32[3],bytes32,address),(bytes32,uint120,bytes32[3],bytes32,address))",
).slice(0, 10); // 0xd34e1968

/** Proof-bearing selectors carry a Railgun Transaction. `redeemAndShield` is proof-bearing (and
 * allow-listed) but its fee is verified by npk-reconstruction, not the broadcaster-output path — the
 * /relay pipeline routes it explicitly (see privacy-relay.ts). */
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
