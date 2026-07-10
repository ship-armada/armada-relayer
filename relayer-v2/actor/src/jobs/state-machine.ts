// ABOUTME: DB-driven CCTP job state machine (§8.4) with v1 iris-relay semantics: attestation
// ABOUTME: polling by source tx, Iris-message broadcast, retry/backoff, mempool-aware stuck recovery.
import type { JobsRepo } from "../db/jobs-repo.js";
import type { CctpJob } from "../db/types.js";
import type { AttestationClient } from "./iris-client.js";
import { MOCK_ATTESTATION } from "./iris-client.js";
import { logger } from "../logger.js";

// Normative constants (§6.4, v1 iris-relay.ts).
export const MAX_RELAY_RETRIES = 5;
export const RETRY_BACKOFF_BASE_MS = 2000; // 2s, 4s, 8s, 16s, 32s (2000 × 2^(attempt-1))
export const IRIS_POLL_CONCURRENCY = 8;

// v1 "already processed" detection on broadcast failure (iris-relay + mock strings).
const ALREADY_PROCESSED_MARKERS = ["already processed", "Nonce already used", "Message already processed"];

export interface ReceiptInfo {
  status: number; // 1 success, 0 revert
  blockNumber: bigint;
}

/** Destination-chain surface the machine needs (wired to WalletManager + HookRouter in main). */
export interface DestinationSubmitter {
  /** relayWithHook via the HookRouter, falling back to MessageTransmitter.receiveMessage
   * when no hookRouter is configured for the destination (v1 submitRelay). */
  submitRelayWithHook(
    destinationDomain: number,
    messageBytes: string,
    attestation: string,
  ): Promise<{ hash: string }>;
  getReceipt(destinationDomain: number, txHash: string): Promise<ReceiptInfo | null>;
  /** True when the tx is still known to the mempool (v1 stuck-tx drop detection). */
  isInMempool(destinationDomain: number, txHash: string): Promise<boolean>;
  /** Nonce-coordinator reset for the destination chain (stuck-tx recovery, §6.5). */
  resetNonce(destinationDomain: number): void;
}

export interface StateMachineDeps {
  jobs: JobsRepo;
  attestations: AttestationClient;
  submitter: DestinationSubmitter;
  irisMode: "mock" | "iris";
  stuckTxThresholdMs: number; // default 600,000, min 60s
  maxAttestationAgeMs: number; // default 3,600,000, min 60s
  now: () => Date;
  onTransition?: (from: string, to: string) => void;
  onIrisPoll?: (result: "complete" | "pending" | "error") => void;
}

const TICK_BATCH = 100;

export class CctpStateMachine {
  constructor(private readonly deps: StateMachineDeps) {}

  /** Runs every per-state tick once. Each transition is a guarded single-row update; a crash
   * mid-tick leaves jobs resumable from their persisted state (§8.4). */
  async tick(): Promise<void> {
    await this.tickDetected();
    await this.tickAwaitingAttestation();
    await this.tickAttested();
    await this.tickSubmitted();
  }

  private transitioned(ok: boolean, from: string, to: string, dedupKey: string): void {
    if (ok) {
      this.deps.onTransition?.(from, to);
      logger.info({ dedupKey, from, to }, "job transition");
    }
  }

  /** detected → awaiting_attestation (iris) | attested with mock bytes (mock mode, §8.4). */
  async tickDetected(): Promise<void> {
    const jobs = await this.deps.jobs.listByState("detected", TICK_BATCH);
    const now = this.deps.now();
    for (const job of jobs) {
      if (this.deps.irisMode === "mock") {
        const ok = await this.deps.jobs.transition(
          job.dedupKey,
          "detected",
          {
            state: "attested",
            attestation: MOCK_ATTESTATION,
            relayMessage: job.messageBytes,
            lastIrisStatus: "mock",
          },
          now,
        );
        this.transitioned(ok, "detected", "attested", job.dedupKey);
      } else {
        const ok = await this.deps.jobs.transition(
          job.dedupKey,
          "detected",
          { state: "awaiting_attestation" },
          now,
        );
        this.transitioned(ok, "detected", "awaiting_attestation", job.dedupKey);
      }
    }
  }

  /** awaiting_attestation → attested | dead_letter on expiry; concurrency 8 per tick (§6.4). */
  async tickAwaitingAttestation(): Promise<void> {
    const jobs = await this.deps.jobs.listByState("awaiting_attestation", TICK_BATCH);
    const now = this.deps.now();

    const expired = jobs.filter(
      (j) => now.getTime() - j.detectedAt.getTime() > this.deps.maxAttestationAgeMs,
    );
    for (const job of expired) {
      const ok = await this.deps.jobs.transition(
        job.dedupKey,
        "awaiting_attestation",
        { state: "dead_letter", deadLetterReason: "expired" },
        now,
      );
      this.transitioned(ok, "awaiting_attestation", "dead_letter", job.dedupKey);
    }

    const pollable = jobs.filter((j) => !expired.includes(j)).slice(0, IRIS_POLL_CONCURRENCY);
    await Promise.all(pollable.map((job) => this.pollOne(job)));
  }

  private async pollOne(job: CctpJob): Promise<void> {
    const result = await this.deps.attestations.fetch({
      sourceDomain: job.sourceDomain,
      sourceTxHash: job.sourceTxHash,
      expectedMessageHex: job.messageBytes,
    });
    this.deps.onIrisPoll?.(result.status);
    const now = this.deps.now();
    if (result.status === "complete") {
      const ok = await this.deps.jobs.transition(
        job.dedupKey,
        "awaiting_attestation",
        {
          state: "attested",
          attestation: result.attestation,
          relayMessage: result.message, // Iris bytes (nonce/finality filled) — what we broadcast
          lastIrisStatus: "complete",
          pollAttempts: job.pollAttempts + 1,
        },
        now,
      );
      this.transitioned(ok, "awaiting_attestation", "attested", job.dedupKey);
    } else {
      await this.deps.jobs.transition(
        job.dedupKey,
        "awaiting_attestation",
        {
          pollAttempts: job.pollAttempts + 1,
          lastIrisStatus:
            result.status === "error" ? `error:${result.detail}` : (result.detail ?? "pending"),
        },
        now,
      );
    }
  }

  /** attested → submitted on broadcast success; already_delivered on replay revert;
   * retry with backoff, dead-letter on exhaustion. */
  async tickAttested(): Promise<void> {
    const jobs = await this.deps.jobs.listByState("attested", TICK_BATCH);
    const now = this.deps.now();
    for (const job of jobs) {
      if (job.nextRetryAt !== null && job.nextRetryAt.getTime() > now.getTime()) continue;
      if (job.attestation === null || job.relayMessage === null) {
        // Persisted attested job without bytes (e.g. pre-Iris restart): re-poll Iris.
        const ok = await this.deps.jobs.transition(
          job.dedupKey,
          "attested",
          { state: "awaiting_attestation" },
          now,
        );
        this.transitioned(ok, "attested", "awaiting_attestation", job.dedupKey);
        continue;
      }
      try {
        const tx = await this.deps.submitter.submitRelayWithHook(
          job.destinationDomain,
          job.relayMessage,
          job.attestation,
        );
        const ok = await this.deps.jobs.transition(
          job.dedupKey,
          "attested",
          {
            state: "submitted",
            submittedTxHash: tx.hash,
            submittedAt: this.deps.now(),
            nextRetryAt: null,
          },
          this.deps.now(),
        );
        this.transitioned(ok, "attested", "submitted", job.dedupKey);
      } catch (err) {
        const message = (err as Error).message ?? "";
        if (ALREADY_PROCESSED_MARKERS.some((m) => message.includes(m))) {
          // Destination replay protection says someone already delivered it (v1
          // "already-processed" outcome) — terminal, not a failure.
          const ok = await this.deps.jobs.transition(
            job.dedupKey,
            "attested",
            { state: "already_delivered" },
            this.deps.now(),
          );
          this.transitioned(ok, "attested", "already_delivered", job.dedupKey);
          continue;
        }
        await this.recordSubmissionFailure(job, message);
      }
    }
  }

  private async recordSubmissionFailure(job: CctpJob, detail: string): Promise<void> {
    const now = this.deps.now();
    const attempts = job.retryAttempts + 1;
    if (attempts > MAX_RELAY_RETRIES) {
      const ok = await this.deps.jobs.transition(
        job.dedupKey,
        "attested",
        { state: "dead_letter", deadLetterReason: "retries-exhausted" },
        now,
      );
      this.transitioned(ok, "attested", "dead_letter", job.dedupKey);
      return;
    }
    // v1 backoff: RELAY_RETRY_BASE_DELAY_MS × 2^(retryAttempts - 1) → 2s,4s,8s,16s,32s
    const delayMs = RETRY_BACKOFF_BASE_MS * 2 ** (attempts - 1);
    await this.deps.jobs.transition(
      job.dedupKey,
      "attested",
      { retryAttempts: attempts, nextRetryAt: new Date(now.getTime() + delayMs) },
      now,
    );
    logger.warn(
      { dedupKey: job.dedupKey, attempts, delayMs, detail: detail.slice(0, 200) },
      "relay broadcast failed; will retry",
    );
  }

  /** submitted → delivered on receipt; mempool-aware stuck-tx recovery (v1 processInflightRelays). */
  async tickSubmitted(): Promise<void> {
    const jobs = await this.deps.jobs.listByState("submitted", TICK_BATCH);
    for (const job of jobs) {
      const now = this.deps.now();
      if (job.submittedAt === null || job.submittedTxHash === null) continue;

      // Receipt polling of our own tx — allowed RPC (D1).
      const receipt = await this.deps.submitter.getReceipt(
        job.destinationDomain,
        job.submittedTxHash,
      );
      if (receipt !== null) {
        if (receipt.status === 1) {
          const ok = await this.deps.jobs.transition(
            job.dedupKey,
            "submitted",
            {
              state: "delivered",
              deliveredTxHash: job.submittedTxHash,
              deliveredBlock: receipt.blockNumber,
              deliveredAt: this.deps.now(),
            },
            this.deps.now(),
          );
          this.transitioned(ok, "submitted", "delivered", job.dedupKey);
        } else {
          // Reverted on-chain (e.g. delivered by someone else): re-enter submission via the
          // retry path; the destination's replay protection remains the final authority (D4).
          const cleared = await this.deps.jobs.transition(
            job.dedupKey,
            "submitted",
            { state: "attested", submittedTxHash: null, submittedAt: null },
            this.deps.now(),
          );
          this.transitioned(cleared, "submitted", "attested", job.dedupKey);
          if (cleared) {
            const fresh = await this.deps.jobs.get(job.dedupKey);
            if (fresh && fresh.state === "attested") {
              await this.recordSubmissionFailure(fresh, "delivery tx reverted");
            }
          }
        }
        continue;
      }

      // No receipt. Stuck check (v1): only recover when the tx has actually DROPPED from the
      // mempool — a slow-but-present tx would double-spend the nonce if we resubmitted.
      if (now.getTime() - job.submittedAt.getTime() > this.deps.stuckTxThresholdMs) {
        const stillPending = await this.deps.submitter.isInMempool(
          job.destinationDomain,
          job.submittedTxHash,
        );
        if (stillPending) {
          logger.warn(
            { dedupKey: job.dedupKey, txHash: job.submittedTxHash },
            "tx exceeded stuck threshold but is still in the mempool — waiting",
          );
          continue;
        }
        this.deps.submitter.resetNonce(job.destinationDomain);
        const ok = await this.deps.jobs.transition(
          job.dedupKey,
          "submitted",
          { state: "attested", submittedTxHash: null, submittedAt: null },
          now,
        );
        this.transitioned(ok, "submitted", "attested", job.dedupKey);
        logger.warn({ dedupKey: job.dedupKey }, "stuck tx dropped from mempool — resubmitting");
      }
    }
  }
}
