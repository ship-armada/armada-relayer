// ABOUTME: Proof-bearing-path fee verification (§6.2 step 5): normalize wrapper calldata to a
// ABOUTME: synthetic transact, decrypt the fee note via the relayer 0zk viewing key, fail closed.
import { RelayError } from "../http/errors.js";
import { normalizeToSyntheticTransact } from "./selectors.js";
import { logger } from "../logger.js";

/** Decrypts the relayer-destined USDC amount from transact calldata (STUB-1: SDK-backed impl
 * in wallet/railgun-wallet.ts; injected here so the pipeline is testable without the SDK). */
export interface NoteAmountExtractor {
  extractFeeNoteUsdcAmount(chainId: number, syntheticTransactCalldata: string): Promise<bigint>;
}

export interface BroadcasterVerifyParams {
  selector: string;
  data: string;
  chainId: number;
  advertisedFee: bigint;
  extractor: NoteAmountExtractor;
}

export async function verifyBroadcasterFee(params: BroadcasterVerifyParams): Promise<void> {
  let synthetic: string;
  try {
    synthetic = normalizeToSyntheticTransact(params.selector, params.data);
  } catch {
    throw new RelayError("INVALID_DATA", "calldata does not normalize to a transact payload");
  }
  let decrypted: bigint;
  try {
    decrypted = await params.extractor.extractFeeNoteUsdcAmount(params.chainId, synthetic);
  } catch (err) {
    // Fail closed (D5): an unverifiable fee is an insufficient fee.
    logger.warn({ err: (err as Error).message }, "fee note extraction failed — rejecting");
    throw new RelayError("FEE_INSUFFICIENT", "fee note could not be verified");
  }
  if (decrypted < params.advertisedFee) {
    throw new RelayError(
      "FEE_INSUFFICIENT",
      `decrypted fee ${decrypted} below advertised ${params.advertisedFee}`,
    );
  }
}
