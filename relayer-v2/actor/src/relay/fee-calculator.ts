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
const USDC_UNIT = 1_000_000n;
const PRICE_SCALE = 1_000_000n; // supports decimal Chainlink prices in v1's integer math

/**
 * fee = gasEstimate × gasPrice × ethUsd × 1e6 / 1e18 × (1 + marginBps/10000), floored (§6.1).
 * Integer arithmetic ported from v1 fee-calculator.ts calculateFeeForGas; the price is
 * scaled by 1e6 so v2's decimal feed prices (§8.8) keep v1's bigint precision.
 */
export function computeFeeUsdcRaw(
  gasEstimate: number,
  gasPriceWei: bigint,
  ethUsdPrice: number,
  profitMarginBps: number,
): bigint {
  const gasCostWei = BigInt(gasEstimate) * gasPriceWei;
  const priceScaled = BigInt(Math.round(ethUsdPrice * Number(PRICE_SCALE)));
  const gasCostUsdc = (gasCostWei * priceScaled * USDC_UNIT) / (10n ** 18n * PRICE_SCALE);
  const marginMultiplier = 10_000n + BigInt(profitMarginBps);
  const feeWithMargin = (gasCostUsdc * marginMultiplier) / 10_000n;
  return feeWithMargin > FEE_FLOOR_USDC_RAW ? feeWithMargin : FEE_FLOOR_USDC_RAW;
}

/**
 * Gross up a NET gas-reimbursement fee so that after the pool's shield fee is charged on the fee
 * NOTE, the relayer still nets the target: `gross = ceil(net × 10000 / (10000 − shieldFeeBps))`.
 *
 * Only the gasless shield tiers (`shield` / `shieldXchain`) are paid via a shield note, so only they
 * are grossed up — the Phase A tiers are paid as SNARK broadcaster outputs (no shield fee charged).
 * The frontend uses the advertised (grossed) fee verbatim as the fee-note value, and the gasless
 * verifier's `value >= advertised` check holds because gasless shields carry integrator = address(0)
 * (deterministic base rate = shieldFeeBps).
 */
export function grossUpForShieldFee(net: bigint, shieldFeeBps: number): bigint {
  const bps = BigInt(shieldFeeBps);
  if (bps <= 0n) return net;
  const denom = 10_000n - bps;
  // Ceil division so the relayer nets >= target after the (floored) on-chain shield fee.
  return (net * 10_000n + denom - 1n) / denom;
}

/** The gasless shield tiers whose advertised fee is grossed up for the on-chain shield fee. */
const SHIELD_FEE_TIERS: ReadonlySet<keyof FeeSchedule["fees"]> = new Set(["shield", "shieldXchain"]);

export interface GasPriceReader {
  /** provider.getFeeData() distilled: gasPrice, falling back to maxFeePerGas, then 1 gwei (§6.1). */
  gasPriceWei(chainId: number): Promise<bigint>;
}

export interface FeeCalculatorOptions {
  feeTtlSeconds: number; // default 300
  feeVarianceBufferBps: number; // default 2000
  profitMarginBps: number;
  /** Pool base shield fee in bps (ArmadaFeeModule.baseArmadaTakeBps) — grosses up the shield tiers. */
  shieldFeeBps: number;
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
      const net = computeFeeUsdcRaw(GAS_ESTIMATES[key], gasPrice, price, this.opts.profitMarginBps);
      // Gasless shield tiers are paid via a shielded fee note the pool charges its shield fee on, so
      // gross up the gas-reimbursement target to keep the relayer whole (see grossUpForShieldFee).
      const quoted = SHIELD_FEE_TIERS.has(key) ? grossUpForShieldFee(net, this.opts.shieldFeeBps) : net;
      fees[key] = quoted.toString();
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
   * v1 getScheduleByCacheId semantics: BOTH schedules stay acceptable until
   * expiresAt + feeTtlSeconds × bufferBps / 10000 ms. cacheId embeds the chainId, so
   * quotes cannot replay cross-chain.
   */
  resolve(chainId: number, cacheId: string): FeeSchedule | null {
    const slot = this.byChain.get(chainId);
    if (!slot) return null;
    const bufferMs = (this.opts.feeTtlSeconds * 1000 * this.opts.feeVarianceBufferBps) / 10_000;
    const now = this.now();
    for (const schedule of [slot.current, slot.previous]) {
      if (schedule && schedule.cacheId === cacheId && now < schedule.expiresAt + bufferMs) {
        return schedule;
      }
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
