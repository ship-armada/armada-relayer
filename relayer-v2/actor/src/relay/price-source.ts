// ABOUTME: ETH/USD price source for the fee formula (§8.8): static on local, Chainlink
// ABOUTME: aggregator with staleness/clamp/last-known-good/static-fallback guards elsewhere.
import { Contract, type Provider } from "ethers";
import { logger } from "../logger.js";

export interface PriceReading {
  price: number; // USD per ETH, plain number (formula divides wei by 1e18)
  degraded: boolean; // true while serving last-known-good or static fallback
}

export interface PriceSource {
  /** Refreshes from the underlying feed (no-op for static). Never throws (§8.8.3). */
  refresh(): Promise<PriceReading>;
  current(): PriceReading;
}

export class StaticPriceSource implements PriceSource {
  constructor(private readonly staticPrice: number) {}
  async refresh(): Promise<PriceReading> {
    return this.current();
  }
  current(): PriceReading {
    return { price: this.staticPrice, degraded: false };
  }
}

/** Minimal Chainlink aggregator surface, injectable for tests. */
export interface AggregatorReader {
  decimals(): Promise<number>;
  latestRoundData(): Promise<{ answer: bigint; updatedAt: bigint }>;
}

const AGGREGATOR_ABI = [
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
];

export function chainlinkAggregator(address: string, provider: Provider): AggregatorReader {
  const contract = new Contract(address, AGGREGATOR_ABI, provider);
  return {
    decimals: async () => Number(await contract.decimals!()),
    latestRoundData: async () => {
      const r = await contract.latestRoundData!();
      return { answer: BigInt(r.answer), updatedAt: BigInt(r.updatedAt) };
    },
  };
}

export interface ChainlinkPriceSourceOptions {
  maxStalenessMs: number; // default 5,400,000 (1h heartbeat + 50%)
  min: number;
  max: number;
  staticFallback: number; // ETH_USD_PRICE_STATIC — emergency floor, required everywhere
  onReading?: (reading: PriceReading) => void; // gauge hook (§8.8.5)
  now?: () => number;
}

export class ChainlinkPriceSource implements PriceSource {
  private feedDecimals: number | null = null;
  private lastGood: number | null = null;
  private degraded = true; // until the first accepted reading

  constructor(
    private readonly reader: AggregatorReader,
    private readonly opts: ChainlinkPriceSourceOptions,
  ) {}

  current(): PriceReading {
    const reading: PriceReading = this.lastGood !== null
      ? { price: this.lastGood, degraded: this.degraded }
      : { price: this.opts.staticFallback, degraded: true };
    return reading;
  }

  async refresh(): Promise<PriceReading> {
    const now = this.opts.now?.() ?? Date.now();
    try {
      if (this.feedDecimals === null) {
        this.feedDecimals = await this.reader.decimals(); // read once at boot (§8.8.4)
      }
      const { answer, updatedAt } = await this.reader.latestRoundData();
      const ageMs = now - Number(updatedAt) * 1000;
      if (ageMs > this.opts.maxStalenessMs) {
        throw new Error(`stale reading: updatedAt ${updatedAt} is ${ageMs}ms old`);
      }
      const price = Number(answer) / 10 ** this.feedDecimals;
      if (!(price >= this.opts.min && price <= this.opts.max)) {
        throw new Error(`reading ${price} outside sanity clamp [${this.opts.min}, ${this.opts.max}]`);
      }
      this.lastGood = price;
      this.degraded = false;
    } catch (err) {
      // Rejected/failed reading: hold last-known-good, mark degraded; never refuse quotes.
      this.degraded = true;
      logger.warn({ err: (err as Error).message }, "ETH/USD feed reading rejected — degraded");
    }
    const reading = this.current();
    this.opts.onReading?.(reading);
    return reading;
  }
}
