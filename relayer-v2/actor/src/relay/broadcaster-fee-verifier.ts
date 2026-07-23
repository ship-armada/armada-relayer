// ABOUTME: Proof-bearing-path fee verification ported from v1 broadcaster-fee-verifier.ts:
// ABOUTME: normalise wrapper calldata to synthetic transact([tx]), decrypt fee notes, fail closed.
import { Interface } from "ethers";
import { RelayError } from "../http/errors.js";
import {
  TRANSACT_SELECTOR,
  WRAPPER_SELECTORS,
  TRANSACT_ABI,
  WRAPPER_ABIS,
} from "./transact-shape.js";
import { selectorOf } from "./selectors.js";
import type { NoteAmountExtractor } from "./wallet-seams.js";
import { logger } from "../logger.js";

/** Hub-scoped context, mirroring v1 BroadcasterVerifierContext: proof-bearing calls are
 * always verified against the hub pool with the hub USDC as the fee token. */
export interface BroadcasterVerifierContext {
  extractor: NoteAmountExtractor;
  privacyPoolAddress: string; // hub pool — synthetic transact target
  usdcAddress: string; // hub USDC — the fee token
}

const wrapperIface = new Interface([...WRAPPER_ABIS]);
const transactIface = new Interface([...TRANSACT_ABI]);

/**
 * Normalises request calldata to a vanilla `transact(Transaction[])` call (v1
 * normaliseRequestToVanillaTransact): pass-through for vanilla transact; wrappers carry a
 * single Transaction struct as arg 0, which is lifted and re-encoded as transact([tx]).
 */
export function normaliseRequestToVanillaTransact(
  data: string,
  privacyPoolAddress: string,
): { to: string; data: string } {
  const selector = selectorOf(data);
  if (selector === TRANSACT_SELECTOR) {
    return { to: privacyPoolAddress, data };
  }
  if (!selector || !WRAPPER_SELECTORS.has(selector)) {
    throw new RelayError("INVALID_DATA", `Verifier received an unsupported selector: ${selector}.`);
  }
  const decoded = wrapperIface.parseTransaction({ data });
  if (!decoded) {
    throw new RelayError("INVALID_DATA", "Wrapper calldata did not decode.");
  }
  const embeddedTransaction = decoded.args[0];
  const syntheticData = transactIface.encodeFunctionData("transact", [[embeddedTransaction]]);
  return { to: privacyPoolAddress, data: syntheticData };
}

/** Verifies the decrypted USDC fee note covers the advertised fee; returns the paid amount. */
export async function verifyBroadcasterFee(
  ctx: BroadcasterVerifierContext,
  data: string,
  advertisedFee: bigint,
): Promise<bigint> {
  let normalised: { to: string; data: string };
  try {
    normalised = normaliseRequestToVanillaTransact(data, ctx.privacyPoolAddress);
  } catch (err) {
    if (err instanceof RelayError) throw err;
    throw new RelayError("INVALID_DATA", "Wrapper calldata did not decode.");
  }

  let amountMap: Record<string, bigint>;
  try {
    amountMap = await ctx.extractor.extractFirstNoteERC20AmountMap(normalised);
  } catch (err) {
    // Fail closed (D5): an unverifiable fee is an insufficient fee (v1 behavior).
    logger.warn({ err: (err as Error).message }, "fee note extraction failed — rejecting");
    throw new RelayError(
      "FEE_INSUFFICIENT",
      `Broadcaster-fee verification failed: ${(err as Error)?.message ?? "could not decode proof outputs"}.`,
    );
  }

  const usdcKey = ctx.usdcAddress.toLowerCase();
  const normalisedMap: Record<string, bigint> = {};
  for (const [k, v] of Object.entries(amountMap)) {
    normalisedMap[k.toLowerCase()] = v;
  }
  const paidUsdc = normalisedMap[usdcKey] ?? 0n;
  if (paidUsdc < advertisedFee) {
    throw new RelayError(
      "FEE_INSUFFICIENT",
      `Broadcaster fee too low: paid ${paidUsdc} USDC raw, advertised ${advertisedFee} USDC raw. ` +
        `Re-fetch the fee quote and re-build the proof with the matching broadcaster fee.`,
    );
  }
  return paidUsdc;
}
