// ABOUTME: The POST /relay validation pipeline, order preserved from v1 (§6.2): chain, target
// ABOUTME: allowlist, fee cache, selector allowlist, fee verification, lock, gas check, submit.
import type { TransactionResponse } from "ethers";
import { RelayError } from "../http/errors.js";
import type { FeeCalculator } from "./fee-calculator.js";
import { advertisedFee } from "./fee-calculator.js";
import {
  ALLOWED_SELECTORS,
  GASLESS_SELECTORS,
  advertisedFeeKeys,
  selectorOf,
} from "./selectors.js";
import { verifyGaslessFee } from "./gasless-fee-verifier.js";
import type { NoteAmountExtractor } from "./broadcaster-fee-verifier.js";
import { verifyBroadcasterFee } from "./broadcaster-fee-verifier.js";
import type { DedupCache } from "./dedup-cache.js";
import { logger, calldataPreview } from "../logger.js";

export interface RelayRequest {
  chainId: number;
  to: string;
  data: string;
  feesCacheId: string;
  idempotencyKey?: string;
}

export interface RelayResult {
  txHash: string;
  status: "pending";
}

/** Per-chain relay context derived from manifests at boot. */
export interface ChainRelayTargets {
  chainId: number;
  allowlist: Set<string>; // lowercase addresses accepted as `to`
  wrapperAddress: string;
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
  targets: Map<number, ChainRelayTargets>;
  feeCalculator: FeeCalculator;
  extractor: NoteAmountExtractor;
  submitter: RelaySubmitter;
  dedup: DedupCache;
  onOutcome?: (selector: string, outcome: "success" | "fail", code: string) => void;
  onFeeReject?: (code: string) => void;
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
      if (err instanceof RelayError && (code === "FEE_INSUFFICIENT" || code === "FEE_EXPIRED")) {
        this.deps.onFeeReject?.(code);
      }
      throw err;
    }
  }

  private async pipeline(req: RelayRequest): Promise<RelayResult> {
    // 1. chainId configured
    const targets = this.deps.targets.get(req.chainId);
    if (!targets) throw new RelayError("INVALID_CHAIN", `chain ${req.chainId} not configured`);

    // 2. target allowlist (case-insensitive)
    if (typeof req.to !== "string" || !targets.allowlist.has(req.to.toLowerCase())) {
      throw new RelayError("INVALID_TARGET", "target not in per-chain allowlist");
    }

    // 3. fee cache resolution (current or previous-within-buffer)
    const schedule = this.deps.feeCalculator.resolve(req.chainId, req.feesCacheId);
    if (!schedule) throw new RelayError("FEE_EXPIRED", "feesCacheId does not resolve");

    // 4. selector allowlist
    const selector = selectorOf(req.data);
    if (!selector || !ALLOWED_SELECTORS.has(selector)) {
      throw new RelayError("INVALID_DATA", "selector not allowed");
    }

    // 5. fee verification (gasless plaintext path vs proof-bearing decrypt path)
    const advertised = advertisedFee(schedule, advertisedFeeKeys(selector));
    if (GASLESS_SELECTORS.has(selector)) {
      verifyGaslessFee({
        selector,
        to: req.to,
        data: req.data,
        wrapperAddress: targets.wrapperAddress,
        advertisedFee: advertised,
      });
    } else {
      await verifyBroadcasterFee({
        selector,
        data: req.data,
        chainId: req.chainId,
        advertisedFee: advertised,
        extractor: this.deps.extractor,
      });
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
      } catch {
        throw new RelayError("GAS_ESTIMATION_FAILED", "transaction would revert");
      }

      // 8. duplicate-calldata dedup, then submit with 20% gas buffer
      if (this.deps.dedup.has(req.chainId, req.data)) {
        throw new RelayError("DUPLICATE_TX", "identical calldata relayed within dedup window");
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
        throw new RelayError("SUBMISSION_FAILED", "broadcast failed");
      }
      this.deps.dedup.record(req.chainId, req.data);
      return { txHash: tx.hash, status: "pending" };
    } finally {
      this.deps.submitter.release(req.chainId);
    }
  }
}
