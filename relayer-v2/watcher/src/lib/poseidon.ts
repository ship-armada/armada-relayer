// ABOUTME: Poseidon hashing for shield commitment hashes (spec §7.3, §8.8 D-A exception): the
// ABOUTME: exact @railgun-community/poseidon-hash-wasm@1.0.1 the engine uses — bit-exact by construction.
// A pure crypto primitive (no keys, no engine) — narrow S6 exception recorded in deviations.md.
// WASM is initialized once at startup and fails LOUD if it doesn't load (no silent JS fallback).
import initPoseidon, { poseidon } from "@railgun-community/poseidon-hash-wasm";

let ready = false;

/** Initialize the WASM once. Call at watcher startup; throws if the module cannot load. */
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
