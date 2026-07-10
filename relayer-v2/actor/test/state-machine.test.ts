// ABOUTME: Exhaustive transition-table tests for the CCTP job state machine (§8.4, §6.4, v1
// ABOUTME: semantics): mock mode, Iris flow/expiry, retries/backoff, mempool-aware stuck recovery.
import { describe, it, expect } from "vitest";
import { InMemoryJobsRepo } from "../src/db/jobs-repo.js";
import {
  CctpStateMachine,
  MAX_RELAY_RETRIES,
  type DestinationSubmitter,
  type StateMachineDeps,
} from "../src/jobs/state-machine.js";
import { MOCK_ATTESTATION, type AttestationClient } from "../src/jobs/iris-client.js";
import { mkJob } from "./helpers.js";

function makeMachine(overrides: Partial<StateMachineDeps> = {}) {
  const jobs = new InMemoryJobsRepo();
  const clock = { t: new Date("2026-01-01T01:00:00Z").getTime() };
  const resets: number[] = [];
  const transitions: [string, string][] = [];
  const submitter: DestinationSubmitter = {
    submitRelayWithHook: async () => ({ hash: "0x" + "aa".repeat(32) }),
    getReceipt: async () => null,
    isInMempool: async () => false,
    resetNonce: (domain) => {
      resets.push(domain);
    },
  };
  const attestations: AttestationClient = {
    fetch: async (q) => ({
      status: "complete",
      attestation: "0x1234",
      message: q.expectedMessageHex,
    }),
  };
  const deps: StateMachineDeps = {
    jobs,
    attestations,
    submitter,
    irisMode: "iris",
    stuckTxThresholdMs: 600_000,
    maxAttestationAgeMs: 3_600_000,
    now: () => new Date(clock.t),
    onTransition: (from, to) => transitions.push([from, to]),
    ...overrides,
  };
  return { machine: new CctpStateMachine(deps), jobs, clock, resets, transitions, deps };
}

describe("detected", () => {
  it("iris mode: detected → awaiting_attestation", async () => {
    const { machine, jobs } = makeMachine();
    await jobs.insertIfAbsent(mkJob({ state: "detected" }));
    await machine.tickDetected();
    expect((await jobs.get(mkJob().dedupKey))!.state).toBe("awaiting_attestation");
  });

  it("mock mode: detected → attested with the empty mock attestation and local bytes", async () => {
    const { machine, jobs } = makeMachine({ irisMode: "mock" });
    await jobs.insertIfAbsent(mkJob({ state: "detected" }));
    await machine.tickDetected();
    const job = (await jobs.get(mkJob().dedupKey))!;
    expect(job.state).toBe("attested");
    expect(job.attestation).toBe(MOCK_ATTESTATION);
    expect(MOCK_ATTESTATION).toBe("0x"); // v1 mock: empty attestation bytes
    expect(job.relayMessage).toBe(job.messageBytes);
  });
});

describe("awaiting_attestation", () => {
  it("complete attestation → attested, persisting the IRIS message for broadcast", async () => {
    const irisMessage = mkJob().messageBytes.replace(/00/, "00"); // same bytes; stands in for nonce-filled copy
    const { machine, jobs } = makeMachine({
      attestations: {
        fetch: async () => ({ status: "complete", attestation: "0x1234", message: irisMessage }),
      },
    });
    await jobs.insertIfAbsent(mkJob({ state: "awaiting_attestation" }));
    await machine.tickAwaitingAttestation();
    const job = (await jobs.get(mkJob().dedupKey))!;
    expect(job.state).toBe("attested");
    expect(job.attestation).toBe("0x1234");
    expect(job.relayMessage).toBe(irisMessage);
    expect(job.lastIrisStatus).toBe("complete");
    expect(job.pollAttempts).toBe(1);
  });

  it("queries Iris by sourceDomain + sourceTxHash with the observed bytes (v1 lookup)", async () => {
    const queries: { sourceDomain: number; sourceTxHash: string }[] = [];
    const { machine, jobs } = makeMachine({
      attestations: {
        fetch: async (q) => {
          queries.push(q);
          return { status: "pending" };
        },
      },
    });
    await jobs.insertIfAbsent(mkJob({ state: "awaiting_attestation" }));
    await machine.tickAwaitingAttestation();
    expect(queries).toEqual([
      {
        sourceDomain: 101,
        sourceTxHash: mkJob().sourceTxHash,
        expectedMessageHex: mkJob().messageBytes,
      },
    ]);
  });

  it("pending attestation increments pollAttempts and stays", async () => {
    const { machine, jobs } = makeMachine({
      attestations: { fetch: async () => ({ status: "pending", detail: "pending_confirmations" }) },
    });
    await jobs.insertIfAbsent(mkJob({ state: "awaiting_attestation" }));
    await machine.tickAwaitingAttestation();
    const job = (await jobs.get(mkJob().dedupKey))!;
    expect(job.state).toBe("awaiting_attestation");
    expect(job.pollAttempts).toBe(1);
    expect(job.lastIrisStatus).toBe("pending_confirmations");
  });

  it("expires to dead_letter after MAX_ATTESTATION_AGE_MS (v1 reason: expired)", async () => {
    const { machine, jobs, clock } = makeMachine();
    const job = mkJob({ state: "awaiting_attestation" });
    await jobs.insertIfAbsent(job);
    clock.t = job.detectedAt.getTime() + 3_600_001;
    await machine.tickAwaitingAttestation();
    const after = (await jobs.get(job.dedupKey))!;
    expect(after.state).toBe("dead_letter");
    expect(after.deadLetterReason).toBe("expired");
  });

  it("polls at most 8 jobs per tick (§6.4 concurrency)", async () => {
    let polls = 0;
    const { machine, jobs } = makeMachine({
      attestations: {
        fetch: async () => {
          polls += 1;
          return { status: "pending" };
        },
      },
    });
    for (let i = 0; i < 12; i++) {
      await jobs.insertIfAbsent(mkJob({ state: "awaiting_attestation", dedupKey: `0xdead:${i}` }));
    }
    await machine.tickAwaitingAttestation();
    expect(polls).toBe(8);
  });
});

describe("attested", () => {
  const ATTESTED = { state: "attested" as const, attestation: "0x1234", relayMessage: mkJob().messageBytes };

  it("broadcast success → submitted with tx fields; broadcasts the relayMessage", async () => {
    const broadcast: string[] = [];
    const { machine, jobs } = makeMachine({
      submitter: {
        submitRelayWithHook: async (_d, message) => {
          broadcast.push(message);
          return { hash: "0x" + "aa".repeat(32) };
        },
        getReceipt: async () => null,
        isInMempool: async () => false,
        resetNonce: () => {},
      },
    });
    await jobs.insertIfAbsent(mkJob(ATTESTED));
    await machine.tickAttested();
    const job = (await jobs.get(mkJob().dedupKey))!;
    expect(job.state).toBe("submitted");
    expect(job.submittedTxHash).toBe("0x" + "aa".repeat(32));
    expect(job.submittedAt).not.toBeNull();
    expect(broadcast).toEqual([mkJob().messageBytes]);
  });

  it("broadcast failure → exponential backoff 2s,4s,8s,16s,32s then dead_letter", async () => {
    const { machine, jobs, clock } = makeMachine({
      submitter: {
        submitRelayWithHook: async () => {
          throw new Error("boom");
        },
        getReceipt: async () => null,
        isInMempool: async () => false,
        resetNonce: () => {},
      },
    });
    const job = mkJob(ATTESTED);
    await jobs.insertIfAbsent(job);
    const expectedDelays = [2000, 4000, 8000, 16000, 32000];
    for (let attempt = 1; attempt <= MAX_RELAY_RETRIES; attempt++) {
      await machine.tickAttested();
      const j = (await jobs.get(job.dedupKey))!;
      expect(j.state).toBe("attested");
      expect(j.retryAttempts).toBe(attempt);
      expect(j.nextRetryAt!.getTime() - clock.t).toBe(expectedDelays[attempt - 1]);
      clock.t = j.nextRetryAt!.getTime() + 1;
    }
    await machine.tickAttested(); // 6th failure exhausts retries
    const dead = (await jobs.get(job.dedupKey))!;
    expect(dead.state).toBe("dead_letter");
    expect(dead.deadLetterReason).toBe("retries-exhausted"); // v1 reason string
  });

  it("'already processed' broadcast error → already_delivered (v1 outcome)", async () => {
    const { machine, jobs } = makeMachine({
      submitter: {
        submitRelayWithHook: async () => {
          throw new Error("execution reverted: Nonce already used");
        },
        getReceipt: async () => null,
        isInMempool: async () => false,
        resetNonce: () => {},
      },
    });
    await jobs.insertIfAbsent(mkJob(ATTESTED));
    await machine.tickAttested();
    expect((await jobs.get(mkJob().dedupKey))!.state).toBe("already_delivered");
  });

  it("respects next_retry_at (does not submit early)", async () => {
    let calls = 0;
    const { machine, jobs, clock } = makeMachine({
      submitter: {
        submitRelayWithHook: async () => {
          calls += 1;
          return { hash: "0xaa" };
        },
        getReceipt: async () => null,
        isInMempool: async () => false,
        resetNonce: () => {},
      },
    });
    await jobs.insertIfAbsent(
      mkJob({ ...ATTESTED, retryAttempts: 1, nextRetryAt: new Date(clock.t + 5000) }),
    );
    await machine.tickAttested();
    expect(calls).toBe(0);
    clock.t += 5001;
    await machine.tickAttested();
    expect(calls).toBe(1);
  });

  it("attested without persisted bytes falls back to awaiting_attestation", async () => {
    const { machine, jobs } = makeMachine();
    await jobs.insertIfAbsent(mkJob({ state: "attested", attestation: null }));
    await machine.tickAttested();
    expect((await jobs.get(mkJob().dedupKey))!.state).toBe("awaiting_attestation");
  });
});

describe("submitted", () => {
  it("successful receipt → delivered with destination fields", async () => {
    const { machine, jobs, clock } = makeMachine({
      submitter: {
        submitRelayWithHook: async () => ({ hash: "0xaa" }),
        getReceipt: async () => ({ status: 1, blockNumber: 555n }),
        isInMempool: async () => false,
        resetNonce: () => {},
      },
    });
    await jobs.insertIfAbsent(
      mkJob({
        state: "submitted",
        submittedTxHash: "0x" + "aa".repeat(32),
        submittedAt: new Date(clock.t - 1000),
      }),
    );
    await machine.tickSubmitted();
    const job = (await jobs.get(mkJob().dedupKey))!;
    expect(job.state).toBe("delivered");
    expect(job.deliveredTxHash).toBe("0x" + "aa".repeat(32));
    expect(job.deliveredBlock).toBe(555n);
    expect(job.deliveredAt).not.toBeNull();
  });

  it("no receipt, under threshold → stays submitted", async () => {
    const { machine, jobs, clock } = makeMachine();
    await jobs.insertIfAbsent(
      mkJob({ state: "submitted", submittedTxHash: "0xaa", submittedAt: new Date(clock.t - 1000) }),
    );
    await machine.tickSubmitted();
    expect((await jobs.get(mkJob().dedupKey))!.state).toBe("submitted");
  });

  it("stuck + dropped from mempool → cleared, nonce reset, back to attested", async () => {
    const { machine, jobs, clock, resets } = makeMachine({
      submitter: {
        submitRelayWithHook: async () => ({ hash: "0xaa" }),
        getReceipt: async () => null,
        isInMempool: async () => false, // dropped
        resetNonce: (d) => resetsProxy.push(d),
      },
    });
    const resetsProxy = resets;
    await jobs.insertIfAbsent(
      mkJob({
        state: "submitted",
        attestation: "0x1234",
        submittedTxHash: "0xaa",
        submittedAt: new Date(clock.t - 600_001),
      }),
    );
    await machine.tickSubmitted();
    const job = (await jobs.get(mkJob().dedupKey))!;
    expect(job.state).toBe("attested");
    expect(job.submittedTxHash).toBeNull();
    expect(job.submittedAt).toBeNull();
    expect(resets).toEqual([100]); // destination domain
  });

  it("stuck but still in mempool → waits (v1: no double-spend of the nonce)", async () => {
    const { machine, jobs, clock, resets } = makeMachine({
      submitter: {
        submitRelayWithHook: async () => ({ hash: "0xaa" }),
        getReceipt: async () => null,
        isInMempool: async () => true, // slow, not dropped
        resetNonce: () => {},
      },
    });
    await jobs.insertIfAbsent(
      mkJob({
        state: "submitted",
        submittedTxHash: "0xaa",
        submittedAt: new Date(clock.t - 600_001),
      }),
    );
    await machine.tickSubmitted();
    expect((await jobs.get(mkJob().dedupKey))!.state).toBe("submitted");
    expect(resets).toEqual([]);
  });

  it("reverted receipt → retry path with backoff", async () => {
    const { machine, jobs, clock } = makeMachine({
      submitter: {
        submitRelayWithHook: async () => ({ hash: "0xaa" }),
        getReceipt: async () => ({ status: 0, blockNumber: 555n }),
        isInMempool: async () => false,
        resetNonce: () => {},
      },
    });
    await jobs.insertIfAbsent(
      mkJob({
        state: "submitted",
        attestation: "0x1234",
        relayMessage: mkJob().messageBytes,
        submittedTxHash: "0xaa",
        submittedAt: new Date(clock.t - 1000),
      }),
    );
    await machine.tickSubmitted();
    const job = (await jobs.get(mkJob().dedupKey))!;
    expect(job.state).toBe("attested");
    expect(job.retryAttempts).toBe(1);
    expect(job.nextRetryAt).not.toBeNull();
  });
});

describe("guarded transitions", () => {
  it("a stale transition (state changed underneath) is a no-op", async () => {
    const jobs = new InMemoryJobsRepo();
    await jobs.insertIfAbsent(mkJob({ state: "delivered" }));
    const ok = await jobs.transition(
      mkJob().dedupKey,
      "attested",
      { state: "submitted" },
      new Date(),
    );
    expect(ok).toBe(false);
    expect((await jobs.get(mkJob().dedupKey))!.state).toBe("delivered");
  });
});
