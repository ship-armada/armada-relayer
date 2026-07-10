// ABOUTME: Poseidon hashing for shield commitment hashes (spec §7.3, §8.8 D-A exception): the
// ABOUTME: exact @railgun-community/poseidon-hash-wasm@1.0.1 the engine uses — bit-exact by construction.
// A pure crypto primitive (no keys, no engine) — narrow S6 exception recorded in deviations.md.
// WASM is initialized once at startup and fails LOUD if it doesn't load (no silent JS fallback).
import initPoseidon, { poseidon } from "@railgun-community/poseidon-hash-wasm";

let ready = false;

/**
 * Initialize the WASM once (idempotent). Called lazily on the first quick-sync request rather
 * than at boot on purpose: a broken WASM then fails loudly on that request only, instead of
 * coupling the whole read API's startup to a dependency that just the quick-sync path uses.
 * Throws if the module cannot load (no silent JS fallback — S6 exception condition).
 */
export async function initPoseidonWasm(): Promise<void> {
  if (ready) return;
  await initPoseidon();
  ready = true;
}

/** poseidon over field elements, matching engine `utils/poseidon.poseidon`. */
export function poseidonHash(inputs: bigint[]): bigint {
  if (!ready) {
    throw new Error("poseidon WASM not initialized — call initPoseidonWasm() at startup");
  }
  return poseidon(inputs);
}
