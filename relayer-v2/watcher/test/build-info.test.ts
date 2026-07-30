// ABOUTME: Unit test for deployedCommit(): reflects the GIT_SHA build arg, "unknown" when absent.
import { describe, it, expect, vi, afterEach } from "vitest";
import { deployedCommit } from "../src/api/lib/build-info";

describe("deployedCommit", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns the commit baked in via GIT_SHA", () => {
    vi.stubEnv("GIT_SHA", "fb65ad74dcdc289f3b6315306ee68ac27392dc26");
    expect(deployedCommit()).toBe("fb65ad74dcdc289f3b6315306ee68ac27392dc26");
  });

  it("falls back to 'unknown' when GIT_SHA is empty", () => {
    vi.stubEnv("GIT_SHA", "");
    expect(deployedCommit()).toBe("unknown");
  });

  it("falls back to 'unknown' when GIT_SHA is unset", () => {
    vi.stubEnv("GIT_SHA", undefined);
    expect(deployedCommit()).toBe("unknown");
  });
});
