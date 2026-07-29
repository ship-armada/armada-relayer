// ABOUTME: Poseidon hashing for shield commitment hashes (spec §7.3, §8.8 D-A exception): the
// ABOUTME: exact @railgun-community/poseidon-hash-wasm@1.0.1 the engine uses — bit-exact by construction.
// A pure crypto primitive (no keys, no engine) — narrow S6 exception recorded in deviations.md.
// WASM is initialized once at startup and fails LOUD if it doesn't load (no silent JS fallback).
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initPoseidon, { poseidon } from "@railgun-community/poseidon-hash-wasm";

const require = createRequire(import.meta.url);

// The published index.d.ts types the default export as a zero-argument init(), but the loader
// Ponder actually runs (pkg-esm __wbg_init) accepts the wasm bytes (InitInput). Cast to the real
// signature so we can hand it the bytes read from disk.
const initPoseidonFromBytes = initPoseidon as unknown as (
  bytes: BufferSource,
) => Promise<unknown>;

let ready = false;

/**
 * Initialize the WASM once (idempotent). Called lazily on the first quick-sync request rather
 * than at boot on purpose: a broken WASM then fails loudly on that request only, instead of
 * coupling the whole read API's startup to a dependency that just the quick-sync path uses.
 * Throws if the module cannot load (no silent JS fallback — S6 exception condition).
 *
 * The wasm bytes are read from disk and handed to the loader explicitly. Ponder resolves this
 * package to its ESM build (the "module" field), whose default loader does
 * fetch(new URL('...bg.wasm', import.meta.url)) — and Node's fetch does not support the file:
 * URL scheme, so the no-argument path throws "fetch failed" at runtime. Passing bytes routes
 * straight to WebAssembly.instantiate and avoids fetch entirely.
 */
export async function initPoseidonWasm(): Promise<void> {
  if (ready) return;
  const wasmPath = require.resolve(
    "@railgun-community/poseidon-hash-wasm/pkg-esm/poseidon_hash_wasm_bg.wasm",
  );
  await initPoseidonFromBytes(await readFile(wasmPath));
  ready = true;
}

/** poseidon over field elements, matching engine `utils/poseidon.poseidon`. */
export function poseidonHash(inputs: bigint[]): bigint {
  if (!ready) {
    throw new Error("poseidon WASM not initialized — call initPoseidonWasm() at startup");
  }
  return poseidon(inputs);
}
