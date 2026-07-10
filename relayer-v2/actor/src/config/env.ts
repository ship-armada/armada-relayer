// ABOUTME: Assembles the actor runtime configuration from NETWORK + env vars + manifests using
// ABOUTME: v1's env-var names (HUB_RPC/CLIENT_A_RPC/CLIENT_B_RPC, CCTP_MODE, RELAYER_*), boot-fail rules.
import type { NetworkTopology } from "./networks.js";
import { assertDomainPairing, getTopology, allChains } from "./networks.js";
import { join } from "node:path";
import type { ChainDeployment, YieldManifest, DeploymentSource } from "./manifests.js";
import { loadAllManifests, loadYieldManifest } from "./manifests.js";

/** Registry environment dir per network (armada-deployments layout); local has no instance. */
const REGISTRY_ENVIRONMENT: Record<string, string> = { sepolia: "testnet", mainnet: "mainnet" };

/**
 * Chooses the manifest source: the central registry when DEPLOYMENT_INSTANCE is set, else flat
 * files (local e2e / monorepo). Registry root defaults to the `deployments/registry` submodule.
 */
export function resolveDeploymentSource(
  env: NodeJS.ProcessEnv,
  network: string,
  deploymentsRoot: string,
): DeploymentSource {
  const instance = env.DEPLOYMENT_INSTANCE;
  if (!instance) {
    return { kind: "flat", root: deploymentsRoot };
  }
  const environment = env.DEPLOYMENT_ENVIRONMENT ?? REGISTRY_ENVIRONMENT[network];
  if (!environment) {
    throw new Error(
      `DEPLOYMENT_INSTANCE is set but no registry environment maps to NETWORK=${network} ` +
        `(expected sepolia|mainnet, or set DEPLOYMENT_ENVIRONMENT explicitly).`,
    );
  }
  const root = env.DEPLOYMENT_REGISTRY_DIR ?? join(deploymentsRoot, "registry");
  return { kind: "registry", root, environment, instance };
}

export type CctpMode = "mock" | "real";

export interface ActorConfig {
  network: NetworkTopology["network"];
  topology: NetworkTopology;
  cctpMode: CctpMode;
  irisBaseUrl: string | null;
  deployments: ChainDeployment[];
  yieldManifest: YieldManifest | null;
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
  profitMarginBps: number; // v1 hardcodes 0; env FEE_PROFIT_MARGIN_BPS is a v2 knob
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

function num(env: NodeJS.ProcessEnv, keys: string | string[], dflt: number, min?: number): number {
  const keyList = Array.isArray(keys) ? keys : [keys];
  for (const key of keyList) {
    const raw = env[key];
    if (raw === undefined || raw === "") continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      throw new Error(`${key} must be a number, got ${JSON.stringify(raw)}`);
    }
    if (min !== undefined && n < min) throw new Error(`${key} must be >= ${min}, got ${n}`);
    return n;
  }
  return dflt;
}

export function buildConfig(env: NodeJS.ProcessEnv, deploymentsRoot: string): ActorConfig {
  // NETWORK is the v2 spec name; DEPLOY_ENV is v1's — accept both.
  const network = env.NETWORK ?? env.DEPLOY_ENV ?? "local";
  const topology = getTopology(network);
  assertDomainPairing(topology);

  // CCTP_MODE per v1 config: mock|real; mainnet+mock is forbidden.
  const cctpMode = (env.CCTP_MODE ?? (topology.network === "local" ? "mock" : "real")) as CctpMode;
  if (cctpMode !== "mock" && cctpMode !== "real") {
    throw new Error(`CCTP_MODE must be mock|real, got ${JSON.stringify(env.CCTP_MODE)}`);
  }
  if (topology.network === "mainnet" && cctpMode === "mock") {
    throw new Error("CCTP_MODE=mock is forbidden on mainnet");
  }
  const irisBaseUrl =
    cctpMode === "mock" ? null : (env.IRIS_API_URL ?? topology.irisBaseUrl);
  if (cctpMode === "real" && !irisBaseUrl) {
    throw new Error("CCTP_MODE=real requires an Iris API URL");
  }

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
  // ETH_USD_PRICE_STATIC is the v2 spec name; ETH_USDC_PRICE is v1's — accept both.
  const ethUsdPriceStatic = num(env, ["ETH_USD_PRICE_STATIC", "ETH_USDC_PRICE"], NaN);
  if (!Number.isFinite(ethUsdPriceStatic) || ethUsdPriceStatic <= 0) {
    throw new Error(
      "ETH_USD_PRICE_STATIC must be set (> 0) on all networks — it is the emergency price floor (§8.8)",
    );
  }

  // Manifests load last so cheap env misconfiguration surfaces before missing-manifest
  // errors; both fail the boot loudly either way (§7.2).
  const source = resolveDeploymentSource(env, topology.network, deploymentsRoot);
  const deployments = loadAllManifests(source, topology);
  const yieldManifest = loadYieldManifest(source, topology);

  return {
    network: topology.network,
    topology,
    cctpMode,
    irisBaseUrl,
    deployments,
    yieldManifest,
    rpcUrls,
    databaseUrl,
    port: num(env, ["RELAYER_PORT", "ACTOR_PORT"], 3001),
    trustProxy: env.RELAYER_TRUST_PROXY === "true",
    bodyLimitBytes: num(env, ["RELAYER_MAX_BODY_BYTES", "BODY_LIMIT_BYTES"], 256 * 1024),
    relayerPrivateKey: env.RELAYER_PRIVATE_KEY ?? null,
    deployerPrivateKey: env.DEPLOYER_PRIVATE_KEY ?? null,
    railgunMnemonic: env.RELAYER_RAILGUN_MNEMONIC ?? null,
    broadcasterRailgunAddress: env.BROADCASTER_RAILGUN_ADDRESS ?? null,
    railgunDbPath: env.RAILGUN_DB_PATH ?? "./state/railgun-db",
    feeTtlSeconds: num(env, "FEE_TTL_SECONDS", 300, 1),
    feeVarianceBufferBps: num(env, "FEE_VARIANCE_BUFFER_BPS", 2000, 0),
    profitMarginBps: num(env, "FEE_PROFIT_MARGIN_BPS", 0, 0), // v1 default: 0
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
    stuckTxThresholdMs: num(
      env,
      ["RELAYER_STUCK_TX_THRESHOLD_MS", "STUCK_TX_THRESHOLD_MS"],
      600_000,
      60_000,
    ),
    maxAttestationAgeMs: num(
      env,
      ["RELAYER_ATTESTATION_AGE_MS", "MAX_ATTESTATION_AGE_MS"],
      3_600_000,
      60_000,
    ),
    fallbackActivateAfterMs: num(env, "FALLBACK_ACTIVATE_AFTER_MS", 120_000, 1000),
    fallbackChunkSize: num(env, "FALLBACK_CHUNK_SIZE", 2000, 10),
    relayRatePerMin: num(
      env,
      ["RELAYER_RATE_LIMIT_RELAY_PER_MIN", "RELAY_RATE_PER_MIN"],
      10,
      1,
    ),
    getRatePerMin: num(env, ["RELAYER_RATE_LIMIT_GET_PER_MIN", "GET_RATE_PER_MIN"], 60, 1),
    indexedSchema: env.INDEXED_SCHEMA ?? "indexed",
  };
}
