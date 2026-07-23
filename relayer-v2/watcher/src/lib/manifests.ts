// ABOUTME: Watcher-side network topology + deployment-manifest loader (§7.2) using the
// ABOUTME: monorepo's real manifest schema and env names. Dependency-independent from the actor.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type NetworkName = "local" | "sepolia" | "mainnet";

export interface WatcherChain {
  chainId: number;
  name: string;
  role: "hub" | "client";
  manifestPrefix: "hub" | "client" | "clientB";
  domain: number;
  rpcUrlEnv: string;
  defaultRpcUrl?: string;
  pollingIntervalMs: number;
  confirmations: number;
}

const CHAINS: Record<NetworkName, WatcherChain[]> = {
  local: [
    { chainId: 31337, name: "hub", role: "hub", manifestPrefix: "hub", domain: 100, rpcUrlEnv: "HUB_RPC", defaultRpcUrl: "http://127.0.0.1:8545", pollingIntervalMs: 1000, confirmations: 0 },
    { chainId: 31338, name: "clientA", role: "client", manifestPrefix: "client", domain: 101, rpcUrlEnv: "CLIENT_A_RPC", defaultRpcUrl: "http://127.0.0.1:8546", pollingIntervalMs: 1000, confirmations: 0 },
    { chainId: 31339, name: "clientB", role: "client", manifestPrefix: "clientB", domain: 102, rpcUrlEnv: "CLIENT_B_RPC", defaultRpcUrl: "http://127.0.0.1:8547", pollingIntervalMs: 1000, confirmations: 0 },
  ],
  sepolia: [
    { chainId: 11155111, name: "hub", role: "hub", manifestPrefix: "hub", domain: 0, rpcUrlEnv: "HUB_RPC", pollingIntervalMs: 12000, confirmations: 6 },
    { chainId: 84532, name: "clientA", role: "client", manifestPrefix: "client", domain: 6, rpcUrlEnv: "CLIENT_A_RPC", pollingIntervalMs: 5000, confirmations: 2 },
    { chainId: 421614, name: "clientB", role: "client", manifestPrefix: "clientB", domain: 3, rpcUrlEnv: "CLIENT_B_RPC", pollingIntervalMs: 5000, confirmations: 2 },
  ],
  mainnet: [
    { chainId: 1, name: "hub", role: "hub", manifestPrefix: "hub", domain: 0, rpcUrlEnv: "HUB_RPC", pollingIntervalMs: 12000, confirmations: 6 },
    { chainId: 8453, name: "clientA", role: "client", manifestPrefix: "client", domain: 6, rpcUrlEnv: "CLIENT_A_RPC", pollingIntervalMs: 5000, confirmations: 2 },
    { chainId: 42161, name: "clientB", role: "client", manifestPrefix: "clientB", domain: 3, rpcUrlEnv: "CLIENT_B_RPC", pollingIntervalMs: 5000, confirmations: 2 },
  ],
};

/** Real manifest shape written by the monorepo's scripts/deploy_privacy_pool.ts. */
export interface Manifest {
  chainId: number;
  domain: number;
  contracts: Record<string, string | undefined>;
  cctp: { tokenMessenger: string; messageTransmitter: string; usdc: string; startBlock?: number };
  hub?: { domain: number; privacyPool: string };
  deployBlock?: number;
}

export interface ResolvedChain extends WatcherChain {
  /** One or more provider URLs; Ponder load-balances across all of them. */
  rpcUrls: string[];
  manifest: Manifest;
}

export function networkName(env: NodeJS.ProcessEnv): NetworkName {
  const network = env.NETWORK ?? env.DEPLOY_ENV ?? "local";
  if (network !== "local" && network !== "sepolia" && network !== "mainnet") {
    throw new Error(`NETWORK must be one of local|sepolia|mainnet, got ${JSON.stringify(network)}`);
  }
  return network;
}

/** Manifest source: central registry (armada-deployments) or flat local files (monorepo e2e). */
export type DeploymentSource =
  | { kind: "flat"; root: string }
  | { kind: "registry"; root: string; environment: string; instance: string };

const REGISTRY_ENVIRONMENT: Record<string, string> = { sepolia: "testnet", mainnet: "mainnet" };

/** Chooses registry when DEPLOYMENT_INSTANCE is set, else flat files (local/monorepo). */
export function resolveSource(env: NodeJS.ProcessEnv, deploymentsRoot: string): DeploymentSource {
  // Compose passes unset vars as EMPTY STRINGS (`${VAR:-}`), so `??` is not enough — treat
  // "" as unset for every optional deployment var. (Mirrors the actor's resolveDeploymentSource.)
  const val = (key: string): string | undefined => {
    const v = env[key];
    return v === undefined || v === "" ? undefined : v;
  };
  const instance = val("DEPLOYMENT_INSTANCE");
  if (!instance) return { kind: "flat", root: deploymentsRoot };
  const network = networkName(env);
  const environment = val("DEPLOYMENT_ENVIRONMENT") ?? REGISTRY_ENVIRONMENT[network];
  if (!environment) {
    throw new Error(
      `DEPLOYMENT_INSTANCE is set but no registry environment maps to NETWORK=${network} ` +
        `(expected sepolia|mainnet, or set DEPLOYMENT_ENVIRONMENT explicitly).`,
    );
  }
  const root = val("DEPLOYMENT_REGISTRY_DIR") ?? join(deploymentsRoot, "registry");
  return { kind: "registry", root, environment, instance };
}

/** Flat file-name convention: privacy-pool-{hub|client|clientB}{-env}.json. */
export function manifestFile(network: NetworkName, chain: WatcherChain): string {
  const suffix = network === "local" ? "" : `-${network}`;
  return `privacy-pool-${chain.manifestPrefix}${suffix}.json`;
}

interface InstanceManifest {
  name: string;
  chains: Record<string, { chainId: number; role: "hub" | "client" }>;
}

/** Locates the registry privacy-pool.json path for a chain (matched by chainId). */
function registryManifestPath(
  source: { root: string; environment: string; instance: string },
  chain: WatcherChain,
): string {
  const dir = join(source.root, source.environment, source.instance);
  const indexPath = join(dir, "manifest.json");
  if (!existsSync(indexPath)) {
    throw new Error(
      `Missing deployment registry instance: expected ${indexPath}. Set DEPLOYMENT_INSTANCE to ` +
        `a published instance and run \`git submodule update --init deployments/registry\`.`,
    );
  }
  const instance = JSON.parse(readFileSync(indexPath, "utf8")) as InstanceManifest;
  const entry = Object.entries(instance.chains).find(([, c]) => c.chainId === chain.chainId);
  if (!entry) {
    throw new Error(
      `Registry instance "${instance.name}" has no chainId ${chain.chainId} (topology ${chain.name}).`,
    );
  }
  const [slug, meta] = entry;
  if (meta.role !== chain.role) {
    throw new Error(
      `Registry chain ${slug} role "${meta.role}" != topology "${chain.role}" (chainId ${chain.chainId}).`,
    );
  }
  return join(dir, slug, "privacy-pool.json");
}

/** Hub CCTP domain for the network (used for xchain_initiated shield rows, which carry
 * no domain in the event — the destination is always the hub). */
export function hubDomain(network: NetworkName): number {
  return CHAINS[network][0]!.domain;
}

export function resolveChains(env: NodeJS.ProcessEnv, deploymentsRoot: string): ResolvedChain[] {
  const network = networkName(env);
  const source = resolveSource(env, deploymentsRoot);
  return CHAINS[network].map((chain) => {
    // Comma-separated lists are supported so free-tier providers can be pooled; Ponder
    // treats each URL as an independent rate-limit bucket and fails over on the first 429.
    const rpcUrls = (env[chain.rpcUrlEnv] ?? chain.defaultRpcUrl ?? "")
      .split(",")
      .map((url) => url.trim())
      .filter((url) => url.length > 0);
    if (rpcUrls.length === 0) {
      throw new Error(`Missing RPC URL for chain ${chain.chainId}: set ${chain.rpcUrlEnv}`);
    }
    const path =
      source.kind === "flat"
        ? join(source.root, manifestFile(network, chain))
        : registryManifestPath(source, chain);
    if (!existsSync(path)) {
      throw new Error(
        `Missing deployment manifest for NETWORK=${network} chainId=${chain.chainId}: ` +
          `expected ${path} (spec §7.2 — manifests are the single source of truth; local ` +
          `manifests are produced by the monorepo's \`npm run setup\`).`,
      );
    }
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
    if (manifest.chainId !== chain.chainId || manifest.domain !== chain.domain) {
      throw new Error(`Manifest ${path} chainId/domain does not match topology`);
    }
    const poolKey = chain.role === "hub" ? "privacyPool" : "privacyPoolClient";
    if (!/^0x[0-9a-fA-F]{40}$/.test(manifest.contracts?.[poolKey] ?? "")) {
      throw new Error(`Manifest ${path} missing contracts.${poolKey}`);
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(manifest.cctp?.messageTransmitter ?? "")) {
      throw new Error(`Manifest ${path} missing cctp.messageTransmitter`);
    }
    return { ...chain, rpcUrls, manifest };
  });
}

/**
 * Start block for MessageTransmitter (CCTP) indexing. Unlike the privacy pools — which must
 * index from deployBlock so quick-sync can rebuild the merkletree from genesis — CCTP messages
 * are only relayed while in flight, so historical CCTP logs serve nothing and backfilling
 * Circle's shared transmitter from deploy is pure RPC waste. Defaults to "latest" (chain head at
 * first sync) so forgetting to configure a block is cheap-and-correct rather than a full-history
 * firehose. Precedence: CCTP_START_BLOCK_<chainId> env override (absolute block or "latest") >
 * manifest cctp.startBlock > "latest". Set an explicit recent block on a fresh/cold deploy to
 * sweep transfers that were burned but not yet delivered when the watcher first syncs.
 */
export function cctpStartBlock(env: NodeJS.ProcessEnv, chain: ResolvedChain): number | "latest" {
  // Compose passes unset vars as empty strings (`${VAR:-}`), so treat "" as unset like resolveSource.
  const raw = env[`CCTP_START_BLOCK_${chain.chainId}`];
  if (raw !== undefined && raw !== "") {
    if (raw === "latest") return "latest";
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(
        `CCTP_START_BLOCK_${chain.chainId} must be a non-negative integer or "latest", got ${JSON.stringify(raw)}`,
      );
    }
    return n;
  }
  const fromManifest = chain.manifest.cctp.startBlock;
  if (fromManifest !== undefined) return fromManifest;
  return "latest";
}

/**
 * The chain's CCTP HookRouter address (lowercased), or null if the manifest carries none.
 * Destination relays route through this contract (actor destination-submitter calls
 * relayWithHook), so it is the `caller` on the MessageReceived logs the actor's delivery-dedup
 * lookahead cares about — see ponder.config's MessageReceived caller filter. A chain without a
 * hookRouter indexes MessageReceived unfiltered.
 */
export function hookRouterAddress(chain: ResolvedChain): string | null {
  const addr = chain.manifest.contracts.hookRouter;
  return addr && /^0x[0-9a-fA-F]{40}$/.test(addr) ? addr.toLowerCase() : null;
}

/** Ponder per-chain config for the CCTP MessageTransmitter, assembled here so the exact shape is
 * unit-testable without a chain (the §15.2 differential test is the chain-level ground-truth check).
 * Forward-only startBlock (cctpStartBlock); when the chain has a hookRouter, a filter that indexes
 * every MessageSent (no indexed args to narrow on) but only our own hookRouter's MessageReceived
 * deliveries (its `caller` arg IS indexed) — third-party deliveries are backstopped by on-chain
 * replay protection (D4). A chain without a hookRouter indexes MessageReceived unfiltered. */
export type MessageTransmitterChainConfig = {
  address: `0x${string}`;
  startBlock: number | "latest";
  filter?: Array<
    | { event: "MessageSent"; args: Record<string, never> }
    | { event: "MessageReceived"; args: { caller: `0x${string}` } }
  >;
};

export function messageTransmitterChain(
  env: NodeJS.ProcessEnv,
  chain: ResolvedChain,
): MessageTransmitterChainConfig {
  const hookRouter = hookRouterAddress(chain);
  return {
    address: chain.manifest.cctp.messageTransmitter as `0x${string}`,
    startBlock: cctpStartBlock(env, chain),
    ...(hookRouter
      ? {
          filter: [
            { event: "MessageSent" as const, args: {} },
            { event: "MessageReceived" as const, args: { caller: hookRouter as `0x${string}` } },
          ],
        }
      : {}),
  };
}

export function poolAddress(chain: ResolvedChain): string {
  return chain.role === "hub"
    ? chain.manifest.contracts.privacyPool!
    : chain.manifest.contracts.privacyPoolClient!;
}

/** Per-chain allowlist of indexed protocol contract addresses, for /v1/logs (P1). */
export function protocolAddressAllowlist(chains: ResolvedChain[]): Map<number, Set<string>> {
  const map = new Map<number, Set<string>>();
  for (const chain of chains) {
    const addresses = [
      ...Object.values(chain.manifest.contracts).filter((a): a is string => !!a),
      chain.manifest.cctp.tokenMessenger,
      chain.manifest.cctp.messageTransmitter,
      chain.manifest.cctp.usdc,
    ];
    map.set(chain.chainId, new Set(addresses.map((a) => a.toLowerCase())));
  }
  return map;
}
