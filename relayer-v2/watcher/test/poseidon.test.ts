// ABOUTME: Regression guard for the poseidon WASM loader (spec §7.3): the ESM build Ponder resolves
// ABOUTME: must be initialized from on-disk bytes, because its default fetch(file://) loader fails in Node.
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
// Import the ESM artifact directly — the exact build Ponder selects via the package "module" field.
// Bare-specifier resolution differs by runtime (Node/vitest pick the CJS build, whose init is a
// no-op that self-loads via fs; Ponder picks this ESM build), so the fetch-based loader that
// actually regressed is only reachable through this explicit subpath. See src/api/lib/poseidon.ts.
import init, {
  poseidon,
} from "@railgun-community/poseidon-hash-wasm/pkg-esm/poseidon_hash_wasm.js";

const require = createRequire(import.meta.url);

function readWasmBytes(): Promise<Buffer> {
  return readFile(
    require.resolve(
      "@railgun-community/poseidon-hash-wasm/pkg-esm/poseidon_hash_wasm_bg.wasm",
    ),
  );
}

describe("poseidon WASM loader (ESM build, §7.3)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("the default no-argument loader depends on fetch (documents why bytes are passed)", async () => {
    // The loader does fetch(new URL('...bg.wasm', import.meta.url)); Node's fetch has no file:
    // support, so at runtime this rejects. Stub fetch to prove the no-arg path routes through it.
    vi.stubGlobal("fetch", () => {
      throw new Error("fetch must not be used to load poseidon wasm");
    });
    await expect(init()).rejects.toThrow();
  });

  it("initializes from on-disk bytes with fetch disabled and hashes bit-exactly", async () => {
    // fetch stays stubbed-to-throw: passing bytes must not touch fetch at all (the runtime fix).
    vi.stubGlobal("fetch", () => {
      throw new Error("fetch must not be used to load poseidon wasm");
    });
    await init(await readWasmBytes());
    // Known-answer vector: raw hex output of the pkg-esm primitive for poseidon(["1","2"]).
    // Pins that the bytes we load are the exact hashing wasm (bit-exactness, spec §7.3).
    expect(poseidon(["1", "2"])).toBe(
      "115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a",
    );
  });
});
