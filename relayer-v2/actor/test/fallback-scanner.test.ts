// ABOUTME: Fallback scanner tests (§8.7): activation on watcher staleness, chunked/bisecting
// ABOUTME: getLogs, feeding the claim path, deactivation once the watcher catches up.
import { describe, it, expect } from "vitest";
import type { Log } from "ethers";
import { AbiCoder, id as topicHash } from "ethers";
import { InMemoryJobsRepo } from "../src/db/jobs-repo.js";
import { InMemoryIndexedReader } from "../src/db/indexed-reader.js";
import { FallbackScanner, getLogsChunked, type ScanProvider } from "../src/jobs/fallback-scanner.js";
import { addressToBytes32 } from "../src/jobs/classify.js";
import type { DiscoveryContext } from "../src/jobs/work-discovery.js";
import { buildCctpMessage, POOL_ADDRESS, HOOK_ROUTER } from "./helpers.js";

const TRANSMITTER = "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9";

function messageSentLog(blockNumber: number, index = 0): Log {
  return {
    address: TRANSMITTER,
    topics: [topicHash("MessageSent(bytes)")],
    data: AbiCoder.defaultAbiCoder().encode(["bytes"], [buildCctpMessage()]),
    blockNumber,
    transactionHash: "0x" + blockNumber.toString(16).padStart(64, "0"),
    index,
  } as unknown as Log;
}

function makeProvider(head: number, logs: Log[], failRanges: [number, number][] = []) {
  const calls: [number, number][] = [];
  const provider: ScanProvider = {
    getBlockNumber: async () => head,
    getLogs: async ({ fromBlock, toBlock }) => {
      calls.push([fromBlock, toBlock]);
      for (const [f, t] of failRanges) {
        if (fromBlock === f && toBlock === t) throw new Error("range too large");
      }
      return logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
  };
  return { provider, calls };
}

describe("getLogsChunked", () => {
  it("splits ranges into chunks", async () => {
    const { provider, calls } = makeProvider(0, []);
    await getLogsChunked(provider, { address: TRANSMITTER, topics: [] }, 1, 25, 10);
    expect(calls).toEqual([
      [1, 10],
      [11, 20],
      [21, 25],
    ]);
  });

  it("bisects on provider errors down to working sub-ranges", async () => {
    const log = messageSentLog(5);
    const { provider, calls } = makeProvider(0, [log], [[1, 10]]);
    const logs = await getLogsChunked(provider, { address: TRANSMITTER, topics: [] }, 1, 10, 10);
    expect(logs).toEqual([log]);
    expect(calls.length).toBeGreaterThan(1); // [1,10] failed, halves succeeded
  });
});

function makeScanner(provider: ScanProvider) {
  const jobs = new InMemoryJobsRepo();
  const indexed = new InMemoryIndexedReader();
  indexed.claimed = async (dedupKey) => (await jobs.get(dedupKey)) !== null;
  const discovery: DiscoveryContext = {
    jobs,
    indexed,
    knownRecipients: new Set([addressToBytes32(POOL_ADDRESS)]),
    hookRouterByDomain: new Map([[100, HOOK_ROUTER]]),
    confirmationsByChain: new Map([[31338, 0]]),
    irisMode: "mock",
    now: () => new Date(clock.t),
  };
  const clock = { t: Date.parse("2026-01-01T00:00:00Z") };
  const activations: [number, boolean][] = [];
  const rpcCalls: string[] = [];
  const scanner = new FallbackScanner({
    chains: [
      {
        chainId: 31338,
        domain: 101,
        messageTransmitter: TRANSMITTER,
        deployBlock: 0,
        confirmations: 0,
        provider,
      },
    ],
    indexed,
    jobs,
    discovery,
    activateAfterMs: 120_000,
    chunkSize: 100,
    now: () => new Date(clock.t),
    onActive: (chainId, active) => activations.push([chainId, active]),
    onRpc: (_c, method) => rpcCalls.push(method),
  });
  return { scanner, jobs, indexed, clock, activations, rpcCalls };
}

describe("FallbackScanner (§8.7)", () => {
  it("stays idle (zero getLogs) while the watcher is fresh — D1", async () => {
    const { provider } = makeProvider(100, [messageSentLog(5)]);
    const h = makeScanner(provider);
    h.indexed.progress = [
      {
        chainId: 31338,
        lastIndexedBlock: 90n,
        lastIndexedBlockTimestamp: new Date(h.clock.t - 1000),
        ready: true,
      },
    ];
    await h.scanner.tick();
    expect(h.scanner.isActive(31338)).toBe(false);
    expect(h.rpcCalls).toEqual([]);
  });

  it("activates when watcher freshness lapses, scans, claims, then deactivates on catch-up", async () => {
    const log = messageSentLog(50);
    const { provider } = makeProvider(100, [log]);
    const h = makeScanner(provider);
    h.indexed.progress = [
      {
        chainId: 31338,
        lastIndexedBlock: 40n,
        lastIndexedBlockTimestamp: new Date(h.clock.t - 300_000), // 5 min stale
        ready: true,
      },
    ];
    await h.scanner.tick();
    expect(h.scanner.isActive(31338)).toBe(true);
    expect(h.activations).toEqual([[31338, true]]);
    expect(h.rpcCalls).toContain("eth_getLogs");
    const job = await h.jobs.get(`${log.transactionHash}:0`);
    expect(job!.state).toBe("detected");

    // watcher recovers past the fallback cursor
    h.indexed.progress = [
      {
        chainId: 31338,
        lastIndexedBlock: 120n,
        lastIndexedBlockTimestamp: new Date(h.clock.t),
        ready: true,
      },
    ];
    await h.scanner.tick();
    expect(h.scanner.isActive(31338)).toBe(false);
    expect(h.activations).toEqual([
      [31338, true],
      [31338, false],
    ]);
  });

  it("activates when the watcher has never indexed at all", async () => {
    const { provider } = makeProvider(10, [messageSentLog(3)]);
    const h = makeScanner(provider);
    h.indexed.progress = [];
    await h.scanner.tick();
    expect(h.scanner.isActive(31338)).toBe(true);
    expect((await h.jobs.get(`${messageSentLog(3).transactionHash}:0`))!.state).toBe("detected");
  });
});
