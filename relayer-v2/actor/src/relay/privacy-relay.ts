// ABOUTME: The POST /relay validation pipeline, order preserved from v1 privacy-relay.ts:
// ABOUTME: chain, target allowlist, fee cache, selector allowlist, fee verify, lock, gas, submit.
import type { TransactionResponse } from "ethers";
import { RelayError } from "../http/errors.js";
import type { FeeCalculator } from "./fee-calculator.js";
import { advertisedFee } from "./fee-calculator.js";
import {
  ALLOWED_SELECTORS,
  GASLESS_SELECTORS,
  SELECTOR_NAMES,
  SELECTOR_REDEEM_AND_SHIELD,
  advertisedFeeKeys,
  selectorOf,
} from "./selectors.js";
import { verifyGaslessFee, type GaslessVerifierContext } from "./gasless-fee-verifier.js";
import { verifyRedeemFee, type RedeemFeeVerifierContext } from "./redeem-fee-verifier.js";
import { verifyBroadcasterFee, type BroadcasterVerifierContext } from "./broadcaster-fee-verifier.js";
import type { DedupCache } from "./dedup-cache.js";
import { logger, calldataPreview } from "../logger.js";

export interface RelayRequest {
  chainId: number;
  to: string;
  data: string;
  feesCacheId: string;
  idempotencyKey?: string;
  /** Per-note blinding factor for the relayer's shielded fee note. Required on the shielded-fee-note
   * paths (redeemAndShield, gasless shield) so the verifier can reconstruct the fee note's npk and
   * confirm it is addressed to the relayer. Ignored on broadcaster-output paths. */
  feeShieldRandom?: string;
}

export interface RelayResult {
  txHash: string;
  status: "pending";
}

/** The submission surface PrivacyRelay needs from the wallet layer (testable seam). */
export interface RelaySubmitter {
  tryAcquire(chainId: number): boolean;
  release(chainId: number): void;
  estimateGas(chainId: number, tx: { to: string; data: string }): Promise<bigint>;
  submit(
    chainId: number,
    tx: { to: string; data: string; gasLimit: bigint },
  ): Promise<Pick<TransactionResponse, "hash">>;
}

export interface PrivacyRelayDeps {
  /** Per-chain allowed `to` targets, lowercase (v1: hub = pool + yieldAdapter + gasless
   * wrapper; clients = poolClient + gasless wrapper client). */
  allowedTargets: Map<number, Set<string>>;
  feeCalculator: FeeCalculator;
  gaslessCtx: GaslessVerifierContext;
  redeemCtx: RedeemFeeVerifierContext;
  broadcasterCtx: BroadcasterVerifierContext;
  submitter: RelaySubmitter;
  dedup: DedupCache;
  onOutcome?: (selector: string, outcome: "success" | "fail", code: string) => void;
  onFeeReject?: (code: string) => void;
  /** v1 /health counters — incremented at v1's exact sites: feeVerifierRejects.<CODE> only
   * at the verifier step, submitSuccess/<submitFail> only at the submit step. */
  counters?: { inc(key: string): void };
}

export class PrivacyRelay {
  constructor(private readonly deps: PrivacyRelayDeps) {}

  async relay(req: RelayRequest): Promise<RelayResult> {
    const selector = selectorOf(req.data) ?? "unknown";
    try {
      const result = await this.pipeline(req);
      this.deps.onOutcome?.(selector, "success", "");
      return result;
    } catch (err) {
      const code = err instanceof RelayError ? err.code : "SUBMISSION_FAILED";
      this.deps.onOutcome?.(selector, "fail", code);
      throw err;
    }
  }

  private async pipeline(req: RelayRequest): Promise<RelayResult> {
    // 1. chainId configured
    const allowedForChain = this.deps.allowedTargets.get(req.chainId);
    if (!allowedForChain) {
      throw new RelayError("INVALID_CHAIN", `chain ${req.chainId} not configured`);
    }

    // 2. target allowlist (case-insensitive)
    if (typeof req.to !== "string" || !req.to || !allowedForChain.has(req.to.toLowerCase())) {
      throw new RelayError("INVALID_TARGET", "target not in per-chain allowlist");
    }

    // 3. fee cache resolution (current or previous, within variance buffer)
    const schedule = this.deps.feeCalculator.resolve(req.chainId, req.feesCacheId);
    if (!schedule) {
      throw new RelayError(
        "FEE_EXPIRED",
        `Fee quote has expired or is invalid for chain ${req.chainId}. Please re-fetch fees.`,
      );
    }

    // 4. selector allowlist
    if (!req.data || req.data.length < 10) {
      throw new RelayError("INVALID_DATA", "Transaction data is empty or too short.");
    }
    const selector = selectorOf(req.data);
    if (!selector || !ALLOWED_SELECTORS.has(selector)) {
      throw new RelayError("INVALID_DATA", `Selector ${selector} is not allowed.`);
    }

    // 5. fee verification against the quoted schedule (v1: any RelayError here counts as a
    // fee-verifier reject before rethrowing)
    const advertised = advertisedFee(schedule, advertisedFeeKeys(selector));
    try {
      if (GASLESS_SELECTORS.has(selector)) {
        // Shielded fee note (gasless): destination proven by npk-reconstruction, needs feeShieldRandom.
        verifyGaslessFee(
          this.deps.gaslessCtx,
          { chainId: req.chainId, to: req.to, data: req.data },
          advertised,
          req.feeShieldRandom,
        );
      } else if (selector === SELECTOR_REDEEM_AND_SHIELD) {
        // Shielded fee note (yield withdraw, #312): fee is a shield output, not an in-proof leg, so
        // it has its own npk-reconstruction verifier rather than the broadcaster-output path.
        verifyRedeemFee(this.deps.redeemCtx, { data: req.data }, advertised, req.feeShieldRandom);
      } else {
        await verifyBroadcasterFee(this.deps.broadcasterCtx, req.data, advertised);
      }
    } catch (err) {
      if (err instanceof RelayError) {
        this.deps.onFeeReject?.(err.code);
        this.deps.counters?.inc(`feeVerifierRejects.${err.code}`);
      }
      throw err;
    }

    // 6. wallet lock
    if (!this.deps.submitter.tryAcquire(req.chainId)) {
      throw new RelayError("RELAYER_BUSY", "wallet busy on this chain");
    }
    try {
      // 7. gas estimation (revert check)
      let gasEstimate: bigint;
      try {
        gasEstimate = await this.deps.submitter.estimateGas(req.chainId, {
          to: req.to,
          data: req.data,
        });
      } catch (err) {
        throw new RelayError(
          "GAS_ESTIMATION_FAILED",
          `Transaction would revert: ${(err as Error).message}`,
        );
      }

      // 8. duplicate-calldata dedup (v1: 409 message embeds the prior txHash — the frontend
      // regexes it out for retry-resume), then submit with a 20% gas buffer
      const duplicate = this.deps.dedup.lookup(req.chainId, req.to, req.data);
      const selectorName = SELECTOR_NAMES.get(selector) ?? "unknown";
      if (duplicate) {
        this.deps.counters?.inc(`submitFail.${selectorName}.DUPLICATE_TX`);
        throw new RelayError(
          "DUPLICATE_TX",
          `Duplicate transaction on chain ${req.chainId} (already submitted as ${duplicate})`,
        );
      }
      let tx: Pick<TransactionResponse, "hash">;
      try {
        tx = await this.deps.submitter.submit(req.chainId, {
          to: req.to,
          data: req.data,
          gasLimit: (gasEstimate * 120n) / 100n,
        });
      } catch (err) {
        logger.warn(
          { chainId: req.chainId, data: calldataPreview(req.data), err: (err as Error).message },
          "relay broadcast failed",
        );
        this.deps.counters?.inc(`submitFail.${selectorName}.SUBMISSION_FAILED`);
        throw new RelayError("SUBMISSION_FAILED", "broadcast failed");
      }
      this.deps.dedup.record(req.chainId, req.to, req.data, tx.hash);
      this.deps.counters?.inc(`submitSuccess.${selectorName}`);
      return { txHash: tx.hash, status: "pending" };
    } finally {
      this.deps.submitter.release(req.chainId);
    }
  }
}
