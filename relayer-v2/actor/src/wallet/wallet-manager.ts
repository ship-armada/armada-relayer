// ABOUTME: Single-EOA wallet across all chains (§6.5): providers, signers, per-chain busy
// ABOUTME: lock (RELAYER_BUSY), balance reads, and serialized submission via the nonce coordinator.
import { JsonRpcProvider, Wallet, type TransactionRequest, type TransactionResponse } from "ethers";
import type { ActorConfig } from "../config/env.js";
import { NonceCoordinator } from "./nonce-coordinator.js";
import { logger } from "../logger.js";

// Anvil's account #0 — the local deployer key. Public knowledge; local mode only.
const LOCAL_DEPLOYER_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export function resolvePrivateKey(config: ActorConfig): string {
  if (config.relayerPrivateKey) return config.relayerPrivateKey;
  const fallback =
    config.deployerPrivateKey ?? (config.network === "local" ? LOCAL_DEPLOYER_KEY : null);
  if (!fallback) {
    throw new Error("RELAYER_PRIVATE_KEY is required (no deployer-key fallback available)");
  }
  if (config.network !== "local") {
    logger.error(
      { network: config.network },
      "SECURITY WARNING: RELAYER_PRIVATE_KEY unset — falling back to the DEPLOYER key on a " +
        "non-local network. Set RELAYER_PRIVATE_KEY before any real operation.",
    );
  } else {
    logger.warn("RELAYER_PRIVATE_KEY unset — using local deployer key (local mode only)");
  }
  return fallback;
}

export class WalletManager {
  private readonly providers = new Map<number, JsonRpcProvider>();
  private readonly signers = new Map<number, Wallet>();
  private readonly busy = new Set<number>();
  readonly nonces: NonceCoordinator;
  readonly address: string;

  constructor(private readonly config: ActorConfig) {
    const key = resolvePrivateKey(config);
    for (const [chainId, url] of config.rpcUrls) {
      const provider = new JsonRpcProvider(url, chainId, { staticNetwork: true });
      this.providers.set(chainId, provider);
      this.signers.set(chainId, new Wallet(key, provider));
    }
    this.address = this.signers.values().next().value!.address;
    this.nonces = new NonceCoordinator(async (chainId) =>
      this.provider(chainId).getTransactionCount(this.address, "pending"),
    );
  }

  provider(chainId: number): JsonRpcProvider {
    const p = this.providers.get(chainId);
    if (!p) throw new Error(`no provider configured for chain ${chainId}`);
    return p;
  }

  signer(chainId: number): Wallet {
    const s = this.signers.get(chainId);
    if (!s) throw new Error(`no signer configured for chain ${chainId}`);
    return s;
  }

  /** Per-chain busy lock backing the RELAYER_BUSY check (§6.2 step 6). */
  tryAcquire(chainId: number): boolean {
    if (this.busy.has(chainId)) return false;
    this.busy.add(chainId);
    return true;
  }

  release(chainId: number): void {
    this.busy.delete(chainId);
  }

  /** Broadcasts through the per-chain nonce stream; nonce advances only on success (§6.5). */
  async submit(chainId: number, tx: TransactionRequest): Promise<TransactionResponse> {
    const signer = this.signer(chainId);
    return this.nonces.withNonce(chainId, (nonce) => signer.sendTransaction({ ...tx, nonce }));
  }

  async balanceWei(chainId: number): Promise<bigint> {
    return this.provider(chainId).getBalance(this.address);
  }
}
