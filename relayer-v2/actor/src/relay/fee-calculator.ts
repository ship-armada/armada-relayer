// ABOUTME: Fee schedule generator preserving the v1 formula and constants exactly (§6.1):
// ABOUTME: USDC raw-unit quotes with TTL, one-deep previous-schedule retention, cacheId format.

export interface FeeSchedule {
  cacheId: string;
  expiresAt: number; // epoch ms
  chainId: number;
  broadcasterRailgunAddress: string;
  fees: {
    transfer: string;
    unshield: string;
    crossContract: string;
    crossChainShield: string;
    crossChainUnshield: string;
    shield: string;
    shieldXchain: string;
  };
}

// Gas estimates per operation (§6.1). `shield` = gaslessShield, `shieldXchain` =
// gaslessCrossChainShield (the schedule keys those operations quote under).
export const GAS_ESTIMATES: Record<keyof FeeSchedule["fees"], number> = {
  transfer: 500_000,
  unshield: 500_000,
  crossChainShield: 500_000,
  crossChainUnshield: 500_000,
  crossContract: 2_000_000,
  shield: 300_000,
  shieldXchain: 400_000,
};

export const FEE_FLOOR_USDC_RAW = 10_000n; // 0.01 USDC (§6.1)
export const ONE_GWEI = 1_000_000_000n;

/** fee = gasEstimate × gasPrice × (ethUsd / 1e18) × (1 + marginBps/10000) × 1e6, floored (§6.1). */
export function computeFeeUsdcRaw(
  gasEstimate: number,
  gasPriceWei: bigint,
  ethUsdPrice: number,
  profitMarginBps: number,
): bigint {
  const wei = Number(gasEstimate) * Number(gasPriceWei);
  const usdc = (wei * ethUsdPrice * (1 + profitMarginBps / 10_000) * 1e6) / 1e18;
  const raw = BigInt(Math.floor(usdc));
  return raw < FEE_FLOOR_USDC_RAW ? FEE_FLOOR_USDC_RAW : raw;
}

export interface GasPriceReader {
  /** provider.getFeeData() distilled: gasPrice, falling back to maxFeePerGas, then 1 gwei (§6.1). */
  gasPriceWei(chainId: number): Promise<bigint>;
}

export interface FeeCalculatorOptions {
  feeTtlSeconds: number; // default 300
  feeVarianceBufferBps: number; // default 2000
  profitMarginBps: number;
  broadcasterRailgunAddress: string;
  now?: () => number;
  /** Called on every regeneration — used to refresh the wallet-balance gauge (§10.1). */
  onRegenerate?: (chainId: number) => void;
}

interface ChainSchedules {
  current: FeeSchedule | null;
  previous: FeeSchedule | null;
}

export class FeeCalculator {
  private counter = 0;
  private readonly byChain = new Map<number, ChainSchedules>();

  constructor(
    private readonly gasReader: GasPriceReader,
    private readonly priceSource: { current(): { price: number } ; refresh(): Promise<unknown> },
    private readonly opts: FeeCalculatorOptions,
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** Returns a fresh-enough schedule, regenerating (gas + price reads) when expired. */
  async getSchedule(chainId: number): Promise<FeeSchedule> {
    const slot = this.byChain.get(chainId) ?? { current: null, previous: null };
    this.byChain.set(chainId, slot);
    const now = this.now();
    if (slot.current && now < slot.current.expiresAt) return slot.current;

    await this.priceSource.refresh(); // at most one feed read per regeneration (§8.8)
    const gasPrice = await this.gasReader.gasPriceWei(chainId);
    const { price } = this.priceSource.current();

    this.counter += 1;
    const fees = {} as FeeSchedule["fees"];
    for (const key of Object.keys(GAS_ESTIMATES) as (keyof FeeSchedule["fees"])[]) {
      fees[key] = computeFeeUsdcRaw(
        GAS_ESTIMATES[key],
        gasPrice,
        price,
        this.opts.profitMarginBps,
      ).toString();
    }
    const schedule: FeeSchedule = {
      cacheId: `fee-${chainId}-${now}-${this.counter}`,
      expiresAt: now + this.opts.feeTtlSeconds * 1000,
      chainId,
      broadcasterRailgunAddress: this.opts.broadcasterRailgunAddress,
      fees,
    };
    slot.previous = slot.current;
    slot.current = schedule;
    this.opts.onRegenerate?.(chainId);
    return schedule;
  }

  /**
   * Resolves a client-supplied feesCacheId to the current or one-deep previous schedule.
   * The previous schedule stays acceptable for feeTtlSeconds × bufferBps / 10000 ms past
   * its expiry (§6.1). cacheId embeds the chainId, so quotes cannot replay cross-chain.
   */
  resolve(chainId: number, cacheId: string): FeeSchedule | null {
    const slot = this.byChain.get(chainId);
    if (!slot) return null;
    const now = this.now();
    if (slot.current?.cacheId === cacheId && now < slot.current.expiresAt) return slot.current;
    const bufferMs = (this.opts.feeTtlSeconds * 1000 * this.opts.feeVarianceBufferBps) / 10_000;
    if (slot.previous?.cacheId === cacheId && now < slot.previous.expiresAt + bufferMs) {
      return slot.previous;
    }
    return null;
  }
}

/** min(fees.transfer, fees.unshield) etc. across the schedule keys a selector quotes under. */
export function advertisedFee(schedule: FeeSchedule, keys: (keyof FeeSchedule["fees"])[]): bigint {
  let min: bigint | null = null;
  for (const key of keys) {
    const v = BigInt(schedule.fees[key]);
    if (min === null || v < min) min = v;
  }
  if (min === null) throw new Error("advertisedFee requires at least one fee key");
  return min;
}
