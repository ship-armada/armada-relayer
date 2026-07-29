// ABOUTME: Guardrail tests — every /relay-allowed selector must resolve to an advertised fee, and
// ABOUTME: every derived selector must equal its deployed on-chain value (the two v1 selector-map bugs).
import { describe, it, expect } from "vitest";
import {
  ALLOWED_SELECTORS,
  advertisedFeeKeys,
  SELECTOR_TRANSACT,
  SELECTOR_LEND_AND_SHIELD,
  SELECTOR_REDEEM_AND_SHIELD,
  SELECTOR_ATOMIC_XCHAIN_UNSHIELD,
  SELECTOR_GASLESS_SHIELD,
  SELECTOR_GASLESS_XCHAIN_SHIELD,
} from "../src/relay/selectors.js";

describe("allowlist ↔ advertised-fee map parity", () => {
  // WHY: the /relay allowlist and the advertised-fee map are two lists keyed by selector that must
  // cover the same set. In v1 they drifted twice — a signature change updated the allowlist but not
  // the fee-map, so a valid cross-chain unshield passed the allowlist then fell through to the fee
  // map's "unreachable" default and was rejected INVALID_DATA. This pins the invariant that broke.
  it("resolves at least one fee key for every selector in ALLOWED_SELECTORS", () => {
    for (const selector of ALLOWED_SELECTORS) {
      expect(
        () => advertisedFeeKeys(selector),
        `selector ${selector} has no advertised-fee mapping`,
      ).not.toThrow();
      expect(advertisedFeeKeys(selector).length).toBeGreaterThan(0);
    }
  });

  it("throws for a selector that is not allow-listed (fail-closed default)", () => {
    expect(() => advertisedFeeKeys("0xdeadbeef")).toThrow(/No advertised-fee mapping/);
  });
});

describe("selectors are anchored to their deployed on-chain values", () => {
  // WHY: selectors are DERIVED from the ABI fragments, so an accidental fragment edit silently moves
  // the selector. Anchoring each to its known on-chain value turns such an edit into a test failure.
  it("pins each derived selector to the contract selector", () => {
    expect(SELECTOR_TRANSACT).toBe("0xd8ae136a");
    expect(SELECTOR_LEND_AND_SHIELD).toBe("0xf2987ad1");
    expect(SELECTOR_REDEEM_AND_SHIELD).toBe("0x7e220759");
    expect(SELECTOR_ATOMIC_XCHAIN_UNSHIELD).toBe("0x2bcba06a");
    expect(SELECTOR_GASLESS_SHIELD).toBe("0x6e53fbcb");
    expect(SELECTOR_GASLESS_XCHAIN_SHIELD).toBe("0xd34e1968");
  });
});
