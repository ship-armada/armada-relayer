// ABOUTME: Gasless-path fee verification (§6.2 step 5): decode the plaintext fee argument,
// ABOUTME: assert the target is the configured wrapper, assert fee >= advertised.
import { RelayError } from "../http/errors.js";
import { decodeGaslessFee } from "./selectors.js";

export interface GaslessVerifyParams {
  selector: string;
  to: string;
  data: string;
  wrapperAddress: string; // configured wrapper for the request chain
  advertisedFee: bigint;
}

export function verifyGaslessFee(params: GaslessVerifyParams): void {
  if (params.to.toLowerCase() !== params.wrapperAddress.toLowerCase()) {
    throw new RelayError("INVALID_TARGET", "gasless calls must target the configured wrapper");
  }
  let fee: bigint;
  try {
    fee = decodeGaslessFee(params.selector, params.data);
  } catch {
    throw new RelayError("INVALID_DATA", "gasless calldata does not decode");
  }
  if (fee < params.advertisedFee) {
    throw new RelayError(
      "FEE_INSUFFICIENT",
      `gasless fee ${fee} below advertised ${params.advertisedFee}`,
    );
  }
}
