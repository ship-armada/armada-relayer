// ABOUTME: Phase-1 unit test for the quick-sync module: empty-result shape and the enum-member
// ABOUTME: string constants (runtime value must equal the engine enum name, §3).
import { describe, it, expect } from "vitest";
import {
  emptyQuickSync,
  SHIELD_COMMITMENT_TYPE,
  TRANSACT_COMMITMENT_V2_TYPE,
} from "../src/api/quick-sync";

describe("quick-sync module (§7.3)", () => {
  it("emptyQuickSync returns the three AccumulatedEvents arrays, all empty", () => {
    expect(emptyQuickSync()).toEqual({
      commitmentEvents: [],
      unshieldEvents: [],
      nullifierEvents: [],
    });
  });

  it("commitment-type constants equal the engine enum names (runtime value)", () => {
    // The engine's CommitmentType enum is string-valued; the builder assigns these literals.
    expect(SHIELD_COMMITMENT_TYPE).toBe("ShieldCommitment");
    expect(TRANSACT_COMMITMENT_V2_TYPE).toBe("TransactCommitmentV2");
  });
});
