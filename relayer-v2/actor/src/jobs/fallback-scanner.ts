// ABOUTME: Fallback MessageSent scanner (§8.7) — the ONLY place the actor may issue getLogs
// ABOUTME: (D1 exception): engages when watcher freshness lapses, bounded + chunked + bisecting.
import { Interface, id as topicHash, keccak256, type Log } from "ethers";
import type { IndexedReader } from "../db/indexed-reader.js";
import type { JobsRepo } from "../db/jobs-repo.js";
import type { IndexedMessageSent } from "../db/types.js";
import type { DiscoveryContext } from "./work-discovery.js";
import { claimMessage } from "./work-discovery.js";
import { decodeMessageHeader } from "./classify.js";
import { logger } from "../logger.js";

const MESSAGE_SENT_TOPIC = topicHash("MessageSent(bytes)");
const MESSAGE_SENT_IFACE = new Interface(["event MessageSent(bytes message)"]);

/** Minimal provider surface for the scanner (testable seam). */
export interface ScanProvider {
  getBlockNumber(): Promise<number>;
  getLogs(filter: {
    address: string;
    topics: string[];
    fromBlock: number;
    toBlock: number;
  }): Promise<Log[]>;
}

export interface ScannerChain {
  chainId: number;
  domain: number;
  messageTransmitter: string;
  deployBlock: number;
  confirmations: number;
  provider: ScanProvider;
}

export interface FallbackScannerDeps {
  chains: ScannerChain[];
  indexed: IndexedReader;
  jobs: JobsRepo;
  discovery: DiscoveryContext;
  activateAfterMs: number; // FALLBACK_ACTIVATE_AFTER_MS, default 120,000
  chunkSize: number;
  now: () => Date;
  onActive?: (chainId: number, active: boolean) => void;
  onRpc?: (chainId: number, method: string) => void;
}

interface ChainScanState {
  active: boolean;
  cursor: bigint | null; // next block to scan
}

/**
 * Chunked getLogs with bisecting fallback: provider errors (range too large, timeouts)
 * halve the range recursively down to single blocks. Bounded port of v1's chunker (§8.2).
 */
export async function getLogsChunked(
  provider: ScanProvider,
  filter: { address: string; topics: string[] },
  fromBlock: number,
  toBlock: number,
  chunkSize: number,
  onRpc?: (method: string) => void,
): Promise<Log[]> {
  const out: Log[] = [];
  let start = fromBlock;
  while (start <= toBlock) {
    const end = Math.min(start + chunkSize - 1, toBlock);
    out.push(...(await bisectingGetLogs(provider, filter, start, end, onRpc)));
    start = end + 1;
  }
  return out;
}

async function bisectingGetLogs(
  provider: ScanProvider,
  filter: { address: string; topics: string[] },
  fromBlock: number,
  toBlock: number,
  onRpc?: (method: string) => void,
): Promise<Log[]> {
  try {
    onRpc?.("eth_getLogs");
    return await provider.getLogs({ ...filter, fromBlock, toBlock });
  } catch (err) {
    if (fromBlock >= toBlock) throw err; // single block still fails: bubble up
    const mid = Math.floor((fromBlock + toBlock) / 2);
    const left = await bisectingGetLogs(provider, filter, fromBlock, mid, onRpc);
    const right = await bisectingGetLogs(provider, filter, mid + 1, toBlock, onRpc);
    return [...left, ...right];
  }
}

export class FallbackScanner {
  private readonly states = new Map<number, ChainScanState>();

  constructor(private readonly deps: FallbackScannerDeps) {}

  isActive(chainId: number): boolean {
    return this.states.get(chainId)?.active ?? false;
  }

  async tick(): Promise<void> {
    const progress = await this.deps.indexed.watcherProgress();
    const progressByChain = new Map(progress.map((p) => [p.chainId, p]));
    for (const chain of this.deps.chains) {
      await this.tickChain(chain, progressByChain.get(chain.chainId));
    }
  }

  private async tickChain(
    chain: ScannerChain,
    progress: { lastIndexedBlock: bigint; lastIndexedBlockTimestamp: Date | null } | undefined,
  ): Promise<void> {
    const state = this.states.get(chain.chainId) ?? { active: false, cursor: null };
    this.states.set(chain.chainId, state);
    const now = this.deps.now().getTime();

    const freshnessMs =
      progress?.lastIndexedBlockTimestamp != null
        ? now - progress.lastIndexedBlockTimestamp.getTime()
        : Number.POSITIVE_INFINITY;

    // Deactivate as soon as the watcher catches up past the fallback cursor (§8.7).
    if (state.active) {
      const caughtUp =
        freshnessMs <= this.deps.activateAfterMs &&
        progress !== undefined &&
        (state.cursor === null || progress.lastIndexedBlock >= state.cursor);
      if (caughtUp) {
        state.active = false;
        state.cursor = null;
        this.deps.onActive?.(chain.chainId, false);
        logger.warn({ chainId: chain.chainId }, "fallback scanner DEACTIVATED — watcher caught up");
        return;
      }
    } else {
      if (freshnessMs <= this.deps.activateAfterMs) return; // watcher healthy — stay idle
      state.active = true;
      state.cursor = null;
      this.deps.onActive?.(chain.chainId, true);
      logger.warn(
        { chainId: chain.chainId, freshnessMs },
        "fallback scanner ACTIVATED — watcher indexing is stale",
      );
    }

    // Cursor: last indexed block, else highest already-claimed block, else deployBlock.
    if (state.cursor === null) {
      const claimed = await this.deps.jobs.maxSourceBlock(chain.domain);
      const base = progress?.lastIndexedBlock ?? claimed ?? BigInt(chain.deployBlock);
      state.cursor = base + 1n;
    }

    this.deps.onRpc?.(chain.chainId, "eth_blockNumber");
    const head = BigInt(await chain.provider.getBlockNumber());
    const safeHead = head - BigInt(chain.confirmations);
    if (state.cursor > safeHead) return;

    const logs = await getLogsChunked(
      chain.provider,
      { address: chain.messageTransmitter, topics: [MESSAGE_SENT_TOPIC] },
      Number(state.cursor),
      Number(safeHead),
      this.deps.chunkSize,
      (method) => this.deps.onRpc?.(chain.chainId, method),
    );

    for (const log of logs) {
      const msg = this.toIndexedShape(chain, log);
      if (msg) await claimMessage(this.deps.discovery, msg);
    }
    state.cursor = safeHead + 1n;
  }

  private toIndexedShape(chain: ScannerChain, log: Log): IndexedMessageSent | null {
    let messageBytes: string;
    try {
      const parsed = MESSAGE_SENT_IFACE.parseLog({ topics: [...log.topics], data: log.data });
      messageBytes = parsed!.args[0] as string;
      decodeMessageHeader(messageBytes); // validates parseability
    } catch {
      logger.warn({ chainId: chain.chainId, tx: log.transactionHash }, "unparseable MessageSent");
      return null;
    }
    const header = decodeMessageHeader(messageBytes);
    return {
      id: `${log.transactionHash}:${log.index}`,
      chainId: chain.chainId,
      sourceDomain: header.sourceDomain,
      destinationDomain: header.destinationDomain,
      messageBytes,
      messageHash: keccak256(messageBytes),
      sourceTxHash: log.transactionHash,
      logIndex: log.index,
      blockNumber: BigInt(log.blockNumber),
      blockTimestamp: 0n,
    };
  }
}
