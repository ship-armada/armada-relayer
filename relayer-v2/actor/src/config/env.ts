// ABOUTME: Assembles the full actor runtime configuration from NETWORK + env vars + manifests,
// ABOUTME: enforcing the boot-fail rules of spec §6.5, §7.2, §8.8 and the constants of §6.
import type { NetworkTopology } from "./networks.js";
import { assertDomainPairing, getTopology, allChains } from "./networks.js";
import type { ChainDeployment } from "./manifests.js";
import { loadAllManifests } from "./manifests.js";

export interface ActorConfig {
  network: NetworkTopology["network"];
  topology: NetworkTopology;
  deployments: ChainDeployment[];
  rpcUrls: Map<number, string>; // chainId -> URL
  databaseUrl: string;
  port: number;
  trustProxy: boolean;
  bodyLimitBytes: number;
  // secrets (never logged)
  relayerPrivateKey: string | null;
  deployerPrivateKey: string | null;
  railgunMnemonic: string | null;
  broadcasterRailgunAddress: string | null;
  railgunDbPath: string;
  // fee schedule (§6.1)
  feeTtlSeconds: number;
  feeVarianceBufferBps: number;
  profitMarginBps: number;
  // price source (§8.8)
  ethUsdPriceStatic: number;
  ethUsdFeedAddress: string | null;
  ethUsdMaxStalenessMs: number;
  ethUsdMin: number;
  ethUsdMax: number;
  // job machine (§6.4, §8.3, §8.7)
  workPollIntervalMs: number;
  stuckTxThresholdMs: number;
  maxAttestationAgeMs: number;
  fallbackActivateAfterMs: number;
  fallbackChunkSize: number;
  // rate limits (§6.3)
  relayRatePerMin: number;
  getRatePerMin: number;
  // watcher progress source (§6.6)
  indexedSchema: string;
}

function num(env: NodeJS.ProcessEnv, key: string, dflt: number, min?: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number, got ${JSON.stringify(raw)}`);
  if (min !== undefined && n < min) {
    throw new Error(`${key} must be >= ${min}, got ${n}`);
  }
  return n;
}

export function buildConfig(env: NodeJS.ProcessEnv, deploymentsRoot: string): ActorConfig {
  const network = env.NETWORK ?? "local";
  const topology = getTopology(network);
  assertDomainPairing(topology);

  const rpcUrls = new Map<number, string>();
  for (const chain of allChains(topology)) {
    const url = env[chain.rpcUrlEnv] ?? chain.defaultRpcUrl;
    if (!url) {
      throw new Error(
        `Missing RPC URL for chain ${chain.chainId} (${chain.name}): set ${chain.rpcUrlEnv}`,
      );
    }
    rpcUrls.set(chain.chainId, url);
  }

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const ethUsdFeedAddress = env.ETH_USD_FEED_ADDRESS ?? null;
  if (topology.network !== "local" && !ethUsdFeedAddress) {
    throw new Error(
      `ETH_USD_FEED_ADDRESS is required on NETWORK=${network} (Chainlink ETH/USD on the hub chain, §8.8)`,
    );
  }
  const ethUsdPriceStatic = num(env, "ETH_USD_PRICE_STATIC", NaN);
  if (!Number.isFinite(ethUsdPriceStatic) || ethUsdPriceStatic <= 0) {
    throw new Error(
      "ETH_USD_PRICE_STATIC must be set (> 0) on all networks — it is the emergency price floor (§8.8)",
    );
  }

  // Manifests load last so cheap env misconfiguration surfaces before missing-manifest
  // errors; both fail the boot loudly either way (§7.2).
  const deployments = loadAllManifests(deploymentsRoot, topology);

  return {
    network: topology.network,
    topology,
    deployments,
    rpcUrls,
    databaseUrl,
    port: num(env, "ACTOR_PORT", 3001),
    trustProxy: env.RELAYER_TRUST_PROXY === "true",
    bodyLimitBytes: num(env, "BODY_LIMIT_BYTES", 256 * 1024),
    relayerPrivateKey: env.RELAYER_PRIVATE_KEY ?? null,
    deployerPrivateKey: env.DEPLOYER_PRIVATE_KEY ?? null,
    railgunMnemonic: env.RELAYER_RAILGUN_MNEMONIC ?? null,
    broadcasterRailgunAddress: env.BROADCASTER_RAILGUN_ADDRESS ?? null,
    railgunDbPath: env.RAILGUN_DB_PATH ?? "./state/railgun-db",
    feeTtlSeconds: num(env, "FEE_TTL_SECONDS", 300, 1),
    feeVarianceBufferBps: num(env, "FEE_VARIANCE_BUFFER_BPS", 2000, 0),
    profitMarginBps: num(env, "FEE_PROFIT_MARGIN_BPS", 1000, 0),
    ethUsdPriceStatic,
    ethUsdFeedAddress,
    ethUsdMaxStalenessMs: num(env, "ETH_USD_MAX_STALENESS_MS", 5_400_000, 60_000),
    ethUsdMin: num(env, "ETH_USD_MIN", 100),
    ethUsdMax: num(env, "ETH_USD_MAX", 100_000),
    workPollIntervalMs: num(
      env,
      "WORK_POLL_INTERVAL_MS",
      topology.network === "local" ? 2000 : 5000,
      100,
    ),
    stuckTxThresholdMs: num(env, "STUCK_TX_THRESHOLD_MS", 600_000, 60_000),
    maxAttestationAgeMs: num(env, "MAX_ATTESTATION_AGE_MS", 3_600_000, 60_000),
    fallbackActivateAfterMs: num(env, "FALLBACK_ACTIVATE_AFTER_MS", 120_000, 1000),
    fallbackChunkSize: num(env, "FALLBACK_CHUNK_SIZE", 2000, 10),
    relayRatePerMin: num(env, "RELAY_RATE_PER_MIN", 10, 1),
    getRatePerMin: num(env, "GET_RATE_PER_MIN", 60, 1),
    indexedSchema: env.INDEXED_SCHEMA ?? "indexed",
  };
}
