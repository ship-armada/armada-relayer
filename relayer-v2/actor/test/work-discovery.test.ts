// ABOUTME: Work-discovery tests (§8.3): confirmation gating from watcher progress, classify
// ABOUTME: outcomes to detected/skipped states, claim-once semantics, zero-RPC design.
import { describe, it, expect } from "vitest";
import { InMemoryJobsRepo } from "../src/db/jobs-repo.js";
import { InMemoryIndexedReader } from "../src/db/indexed-reader.js";
import { discoverWork, type DiscoveryContext } from "../src/jobs/work-discovery.js";
import { addressToBytes32 } from "../src/jobs/classify.js";
import { buildCctpMessage, mkIndexedMessage, POOL_ADDRESS, HOOK_ROUTER } from "./helpers.js";

function makeCtx() {
  const jobs = new InMemoryJobsRepo();
  const indexed = new InMemoryIndexedReader();
  indexed.claimed = async (id) => (await jobs.get(id)) !== null;
  const ctx: DiscoveryContext = {
    jobs,
    indexed,
    knownRecipients: new Set([addressToBytes32(POOL_ADDRESS)]),
    hookRouterByDomain: new Map([[100, HOOK_ROUTER]]),
    confirmationsByChain: new Map([[31338, 2]]),
    irisMode: "iris",
    now: () => new Date("2026-01-01T00:00:00Z"),
  };
  return { ctx, jobs, indexed };
}

describe("discoverWork (§8.3)", () => {
  it("claims confirmed relayable messages as detected", async () => {
    const { ctx, jobs, indexed } = makeCtx();
    indexed.progress = [
      { chainId: 31338, lastIndexedBlock: 110n, lastIndexedBlockTimestamp: new Date(), ready: true },
    ];
    indexed.messages = [mkIndexedMessage({ blockNumber: 100n })];
    expect(await discoverWork(ctx)).toBe(1);
    const job = await jobs.get(indexed.messages[0]!.id);
    expect(job!.state).toBe("detected");
    expect(job!.sourceBlock).toBe(100n);
  });

  it("applies the confirmation gate: blocks above lastIndexed - confirmations wait", async () => {
    const { ctx, jobs, indexed } = makeCtx();
    indexed.progress = [
      { chainId: 31338, lastIndexedBlock: 101n, lastIndexedBlockTimestamp: new Date(), ready: true },
    ];
    indexed.messages = [mkIndexedMessage({ blockNumber: 100n })]; // gate = 101-2 = 99
    expect(await discoverWork(ctx)).toBe(0);
    expect(await jobs.get(indexed.messages[0]!.id)).toBeNull();
  });

  it("inserts non-relayable messages as skipped with the reason", async () => {
    const { ctx, jobs, indexed } = makeCtx();
    indexed.progress = [
      { chainId: 31338, lastIndexedBlock: 110n, lastIndexedBlockTimestamp: new Date(), ready: true },
    ];
    indexed.messages = [
      mkIndexedMessage({ messageBytes: buildCctpMessage({ bodyVersion: 2 }) }),
    ];
    await discoverWork(ctx);
    const job = await jobs.get(indexed.messages[0]!.id);
    expect(job!.state).toBe("skipped");
    expect(job!.deadLetterReason).toBe("body_version:2");
  });

  it("claims each message exactly once across ticks", async () => {
    const { ctx, indexed } = makeCtx();
    indexed.progress = [
      { chainId: 31338, lastIndexedBlock: 110n, lastIndexedBlockTimestamp: new Date(), ready: true },
    ];
    indexed.messages = [mkIndexedMessage()];
    expect(await discoverWork(ctx)).toBe(1);
    expect(await discoverWork(ctx)).toBe(0);
  });

  it("no watcher progress => discovers nothing (fallback scanner's job)", async () => {
    const { ctx, indexed } = makeCtx();
    indexed.messages = [mkIndexedMessage()];
    expect(await discoverWork(ctx)).toBe(0);
  });

  it("marks messages already received at destination as already_delivered (nonzero nonce)", async () => {
    const { ctx, jobs, indexed } = makeCtx();
    const nonce = "0x" + "ab".repeat(32);
    indexed.progress = [
      { chainId: 31338, lastIndexedBlock: 110n, lastIndexedBlockTimestamp: new Date(), ready: true },
    ];
    indexed.messages = [mkIndexedMessage({ messageBytes: buildCctpMessage({ nonce }) })];
    indexed.received.add(`101:${nonce}`);
    await discoverWork(ctx);
    expect((await jobs.get(indexed.messages[0]!.id))!.state).toBe("already_delivered");
  });
});
