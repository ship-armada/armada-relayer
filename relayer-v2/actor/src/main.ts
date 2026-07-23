// ABOUTME: Actor entrypoint: builds config from NETWORK + manifests, boots wallets, wires the
// ABOUTME: relay pipeline, job state machine, work discovery, fallback scanner, and HTTP API.
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildConfig, type ActorConfig } from "./config/env.js";
import { allChains } from "./config/networks.js";
import { poolAddress, gaslessWrapperAddress } from "./config/manifests.js";
import { createPool } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { PgJobsRepo } from "./db/jobs-repo.js";
import { PgIdempotencyRepo } from "./db/idempotency-repo.js";
import { PgIndexedReader } from "./db/indexed-reader.js";
import { WalletManager } from "./wallet/wallet-manager.js";
import { bootRailgunWallet } from "./wallet/railgun-wallet.js";
import { FeeCalculator } from "./relay/fee-calculator.js";
import {
  StaticPriceSource,
  ChainlinkPriceSource,
  chainlinkAggregator,
  type PriceSource,
} from "./relay/price-source.js";
import { PrivacyRelay, type RelaySubmitter } from "./relay/privacy-relay.js";
import { DedupCache } from "./relay/dedup-cache.js";
import { addressToBytes32 } from "./jobs/classify.js";
import { CctpStateMachine } from "./jobs/state-machine.js";
import { createDestinationSubmitter, type DomainTarget } from "./jobs/destination-submitter.js";
import { discoverWork, type DiscoveryContext } from "./jobs/work-discovery.js";
import { FallbackScanner, type ScannerChain } from "./jobs/fallback-scanner.js";
import { IrisClient, MockAttestationClient } from "./jobs/iris-client.js";
import { createMetrics } from "./metrics.js";
import { createApp, type TxStatusResult } from "./http/server.js";
import { classifyChain, Counters, type ChainHealthReport } from "./http/health.js";
import { logger } from "./logger.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function main(): Promise<void> {
  const config = buildConfig(
    process.env,
    process.env.DEPLOYMENTS_DIR ?? join(REPO_ROOT, "deployments"),
  );
  logger.info({ network: config.network, cctpMode: config.cctpMode }, "actor booting");

  const pool = createPool(config.databaseUrl);
  await migrate(config.databaseUrl);
  const jobs = new PgJobsRepo(pool);
  const idempotency = new PgIdempotencyRepo(pool);
  const indexed = new PgIndexedReader(pool, config.indexedSchema);
  const metrics = createMetrics();
  const counters = new Counters();

  const wallet = new WalletManager(config);
  const railgun = await bootRailgunWallet(config);

  // --- price source (§8.8) ---
  const priceSource: PriceSource =
    config.network === "local"
      ? new StaticPriceSource(config.ethUsdPriceStatic)
      : new ChainlinkPriceSource(
          chainlinkAggregator(
            config.ethUsdFeedAddress!,
            wallet.provider(config.topology.hub.chainId),
          ),
          {
            maxStalenessMs: config.ethUsdMaxStalenessMs,
            min: config.ethUsdMin,
            max: config.ethUsdMax,
            staticFallback: config.ethUsdPriceStatic,
            onReading: (r) => metrics.setEthUsdPrice(r.price, r.degraded),
          },
        );

  // --- fee calculator (§6.1); wallet balance gauge refresh on regeneration (§10.1) ---
  const feeCalculator = new FeeCalculator(
    {
      gasPriceWei: async (chainId) => {
        metrics.rpcRequest(chainId, "eth_feeData");
        const feeData = await wallet.provider(chainId).getFeeData();
        return feeData.gasPrice ?? feeData.maxFeePerGas ?? 1_000_000_000n;
      },
    },
    priceSource,
    {
      feeTtlSeconds: config.feeTtlSeconds,
      feeVarianceBufferBps: config.feeVarianceBufferBps,
      profitMarginBps: config.profitMarginBps,
      shieldFeeBps: config.shieldFeeBps,
      broadcasterRailgunAddress: railgun.railgunAddress,
      onRegenerate: (chainId) => {
        void wallet
          .balanceWei(chainId)
          .then((wei) => {
            metrics.rpcRequest(chainId, "eth_getBalance");
            metrics.setWalletBalance(chainId, wei);
          })
          .catch(() => {});
      },
    },
  );

  // --- relay pipeline (§6.2); allowlists per v1 armada-relayer.ts:237 ---
  const hubDeployment = config.deployments.find((d) => d.chain.role === "hub")!;
  const allowedTargets = new Map<number, Set<string>>();
  const wrappersByChain = new Map<number, string>();
  for (const d of config.deployments) {
    const targets = [poolAddress(d)];
    const wrapper = gaslessWrapperAddress(d);
    if (wrapper) {
      targets.push(wrapper);
      wrappersByChain.set(d.chain.chainId, wrapper);
    }
    if (d.chain.role === "hub" && config.yieldManifest?.contracts.armadaYieldAdapter) {
      targets.push(config.yieldManifest.contracts.armadaYieldAdapter);
    }
    allowedTargets.set(d.chain.chainId, new Set(targets.map((a) => a.toLowerCase())));
  }
  const submitter: RelaySubmitter = {
    tryAcquire: (chainId) => wallet.tryAcquire(chainId),
    release: (chainId) => wallet.release(chainId),
    estimateGas: async (chainId, tx) => {
      metrics.rpcRequest(chainId, "eth_estimateGas");
      return wallet.provider(chainId).estimateGas({ ...tx, from: wallet.address });
    },
    submit: async (chainId, tx) => {
      metrics.rpcRequest(chainId, "eth_sendRawTransaction");
      return wallet.submit(chainId, tx);
    },
  };
  const dedup = new DedupCache();
  setInterval(() => dedup.sweep(), 5 * 60 * 1000).unref?.();
  const relay = new PrivacyRelay({
    allowedTargets,
    feeCalculator,
    // The same railgun wallet service backs the npk-reconstruction seam AND the published
    // broadcasterRailgunAddress (feeCalculator, above) — one identity, so honest shielded fee notes
    // verify against the key that was advertised (fee-destination invariant).
    gaslessCtx: { wrappersByChain, deriver: railgun },
    redeemCtx: { deriver: railgun },
    broadcasterCtx: {
      extractor: railgun,
      privacyPoolAddress: hubDeployment.manifest.contracts.privacyPool!,
      usdcAddress: hubDeployment.manifest.cctp.usdc,
    },
    submitter,
    dedup,
    onOutcome: (selector, outcome, code) => metrics.relaySubmission(selector, outcome, code),
    onFeeReject: (code) => metrics.feeVerifierReject(code),
    counters,
  });

  // --- CCTP job pipeline (§8.3–§8.7) ---
  const knownRecipients = new Set(config.deployments.map((d) => addressToBytes32(poolAddress(d))));
  const hookRouterByDomain = new Map<number, string | null>(
    config.deployments.map((d) => [d.chain.domain, d.manifest.contracts.hookRouter ?? null]),
  );
  const domainTargets = new Map<number, DomainTarget>(
    config.deployments.map((d) => [
      d.chain.domain,
      {
        chainId: d.chain.chainId,
        hookRouter: d.manifest.contracts.hookRouter ?? null,
        messageTransmitter: d.manifest.cctp.messageTransmitter,
      },
    ]),
  );
  const confirmationsByChain = new Map(
    allChains(config.topology).map((c) => [c.chainId, c.confirmations]),
  );

  const discovery: DiscoveryContext = {
    jobs,
    indexed,
    knownRecipients,
    hookRouterByDomain,
    confirmationsByChain,
    irisMode: config.cctpMode === "mock" ? "mock" : "iris",
    now: () => new Date(),
    onTransition: (from, to) => metrics.jobTransition(from, to),
  };
  const machine = new CctpStateMachine({
    jobs,
    attestations:
      config.cctpMode === "mock"
        ? new MockAttestationClient()
        : new IrisClient(config.irisBaseUrl!),
    submitter: createDestinationSubmitter(wallet, domainTargets, metrics),
    irisMode: config.cctpMode === "mock" ? "mock" : "iris",
    stuckTxThresholdMs: config.stuckTxThresholdMs,
    maxAttestationAgeMs: config.maxAttestationAgeMs,
    now: () => new Date(),
    onTransition: (from, to) => metrics.jobTransition(from, to),
    onIrisPoll: (result) => metrics.irisPoll(result),
  });
  const scanner = new FallbackScanner({
    chains: config.deployments.map(
      (d): ScannerChain => ({
        chainId: d.chain.chainId,
        domain: d.chain.domain,
        messageTransmitter: d.manifest.cctp.messageTransmitter,
        deployBlock: d.manifest.deployBlock ?? 0,
        confirmations: d.chain.confirmations,
        provider: wallet.provider(d.chain.chainId),
      }),
    ),
    indexed,
    jobs,
    discovery,
    activateAfterMs: config.fallbackActivateAfterMs,
    chunkSize: config.fallbackChunkSize,
    now: () => new Date(),
    onActive: (chainId, active) => metrics.setFallbackActive(chainId, active),
    onRpc: (chainId, method) => metrics.rpcRequest(chainId, method),
  });

  let jobTickRunning = false;
  const jobTick = async (): Promise<void> => {
    if (jobTickRunning) return; // ticks never overlap
    jobTickRunning = true;
    try {
      await discoverWork(discovery);
      await machine.tick();
      await scanner.tick();
      metrics.setCctpJobsSnapshot(await jobs.countsByState());
    } catch (err) {
      logger.error({ err: (err as Error).message }, "job tick failed");
    } finally {
      jobTickRunning = false;
    }
  };
  const jobTimer = setInterval(() => void jobTick(), config.workPollIntervalMs);

  // --- HTTP (§9.1) ---
  const chainHealth = async (): Promise<ChainHealthReport[]> => {
    const progress = await indexed.watcherProgress();
    const byChain = new Map(progress.map((p) => [p.chainId, p]));
    const counts = await jobs.countsByState();
    const nowMs = Date.now();
    return allChains(config.topology).map((c) => {
      const domain = c.domain;
      let pendingCount = 0;
      let deadLetterCount = 0;
      for (const [key, n] of counts) {
        const [state, d] = key.split(":");
        if (Number(d) !== domain) continue;
        if (["detected", "awaiting_attestation", "attested", "submitted"].includes(state!)) {
          pendingCount += n;
        } else if (state === "dead_letter") {
          deadLetterCount += n;
        }
      }
      return classifyChain(nowMs, {
        chainName: c.name,
        domain,
        pollIntervalMs: c.pollingIntervalMs,
        nominalBlockTimeMs: c.nominalBlockTimeMs,
        progress: byChain.get(c.chainId),
        pendingCount,
        deadLetterCount,
      });
    });
  };
  const txStatus = async (txHash: string, chainId?: number): Promise<TxStatusResult> => {
    const chainIds = chainId === undefined ? [...config.rpcUrls.keys()] : [chainId];
    for (const id of chainIds) {
      try {
        metrics.rpcRequest(id, "eth_getTransactionReceipt");
        const receipt = await wallet.provider(id).getTransactionReceipt(txHash);
        if (receipt) {
          return receipt.status === 1
            ? { status: "confirmed", blockNumber: receipt.blockNumber }
            : {
                status: "failed",
                blockNumber: receipt.blockNumber,
                error: "Transaction reverted on-chain",
              };
        }
      } catch {
        // unreachable chain during fan-out: keep looking
      }
    }
    return { status: "pending" };
  };

  const app = createApp({
    hubChainId: config.topology.hub.chainId,
    configuredChainIds: [...config.rpcUrls.keys()],
    feeCalculator,
    relay,
    idempotency,
    jobs,
    txStatus,
    chainHealth,
    counters,
    metrics,
    trustProxy: config.trustProxy,
    bodyLimitBytes: config.bodyLimitBytes,
    relayRatePerMin: config.relayRatePerMin,
    getRatePerMin: config.getRatePerMin,
  });
  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, "actor HTTP API listening");
  });

  const shutdown = (): void => {
    logger.info("shutting down");
    clearInterval(jobTimer);
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.fatal({ err: (err as Error).message }, "actor boot failed");
  process.exit(1);
});

export type { ActorConfig };
