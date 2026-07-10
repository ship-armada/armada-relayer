// ABOUTME: Gasless-path fee verification ported from v1 gasless-fee-verifier.ts: per-chain
// ABOUTME: wrapper check, plaintext fee decode (arg 2 / permitInput[2]), fee >= advertised.
import { RelayError } from "../http/errors.js";
import { decodeGaslessFee } from "./selectors.js";

/** Mirrors v1 GaslessVerifierContext: hub -> GaslessShieldWrapper, clients ->
 * GaslessShieldWrapperClient (from the privacy-pool manifests). */
export interface GaslessVerifierContext {
  wrappersByChain: Map<number, string>;
}

export function verifyGaslessFee(
  ctx: GaslessVerifierContext,
  request: { chainId: number; to: string; data: string },
  advertisedFee: bigint,
): void {
  const expectedWrapper = ctx.wrappersByChain.get(request.chainId);
  if (!expectedWrapper) {
    throw new RelayError(
      "INVALID_CHAIN",
      `No gasless wrapper configured for chain ${request.chainId}.`,
    );
  }
  if (request.to.toLowerCase() !== expectedWrapper.toLowerCase()) {
    throw new RelayError("INVALID_TARGET", "Gasless calls must target the configured wrapper.");
  }
  const selector = request.data.slice(0, 10).toLowerCase();
  let fee: bigint;
  try {
    fee = decodeGaslessFee(selector, request.data);
  } catch {
    throw new RelayError("INVALID_DATA", "Gasless wrapper calldata did not decode.");
  }
  if (fee < advertisedFee) {
    throw new RelayError(
      "FEE_INSUFFICIENT",
      `Gasless wrapper fee ${fee} is below advertised fee ${advertisedFee}`,
    );
  }
}
