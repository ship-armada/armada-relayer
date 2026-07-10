// ABOUTME: Loads privacy-pool deployment manifests using the monorepo's real schema and flat
// ABOUTME: naming (privacy-pool-{hub|client|clientB}{-env}.json) — source of truth for addresses.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ChainTopology, NetworkTopology } from "./networks.js";
import { allChains } from "./networks.js";

/** Real manifest shape written by scripts/deploy_privacy_pool.ts (monorepo). */
export interface DeploymentManifest {
  chainId: number;
  domain: number;
  deployer?: string;
  contracts: {
    privacyPool?: string;
    privacyPoolClient?: string;
    hookRouter?: string;
    gaslessShieldWrapper?: string;
    gaslessShieldWrapperClient?: string;
    [key: string]: string | undefined;
  };
  cctp: {
    tokenMessenger: string;
    messageTransmitter: string;
    usdc: string;
  };
  hub?: { domain: number; privacyPool: string };
  deployBlock?: number;
  timestamp?: string;
}

/** yield-hub manifest — supplies the ArmadaYieldAdapter for the hub target allowlist. */
export interface YieldManifest {
  chainId: number;
  contracts: { armadaYieldVault?: string; armadaYieldAdapter?: string };
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** File-name suffix per network — v1 config.ts convention: "" local, "-sepolia", "-mainnet". */
export function networkSuffix(network: string): string {
  return network === "local" ? "" : `-${network}`;
}

export function poolManifestFile(network: string, chain: ChainTopology): string {
  return `privacy-pool-${chain.manifestPrefix}${networkSuffix(network)}.json`;
}

export function yieldManifestFile(network: string): string {
  return `yield-hub${networkSuffix(network)}.json`;
}

export function loadManifest(
  deploymentsRoot: string,
  network: string,
  chain: ChainTopology,
): DeploymentManifest {
  const path = join(deploymentsRoot, poolManifestFile(network, chain));
  if (!existsSync(path)) {
    throw new Error(
      `Missing deployment manifest for NETWORK=${network} chainId=${chain.chainId}: ` +
        `expected ${path}. Manifests under deployments/ are the single source of truth ` +
        `for addresses and deployBlock (spec §7.2); refusing to boot without one. ` +
        `(Local manifests are produced by the monorepo's \`npm run setup\`.)`,
    );
  }
  let parsed: DeploymentManifest;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Unparseable deployment manifest ${path}: ${(err as Error).message}`);
  }
  validateManifest(parsed, path, chain);
  return parsed;
}

function validateManifest(m: DeploymentManifest, path: string, chain: ChainTopology): void {
  const fail = (msg: string): never => {
    throw new Error(`Invalid deployment manifest ${path}: ${msg}`);
  };
  if (m.chainId !== chain.chainId) fail(`chainId ${m.chainId} != expected ${chain.chainId}`);
  if (m.domain !== chain.domain) fail(`domain ${m.domain} != expected ${chain.domain}`);
  if (m.deployBlock !== undefined && (!Number.isInteger(m.deployBlock) || m.deployBlock < 0)) {
    fail(`deployBlock must be a non-negative integer, got ${m.deployBlock}`);
  }
  const poolKey = chain.role === "hub" ? "privacyPool" : "privacyPoolClient";
  const pool = m.contracts?.[poolKey];
  if (!pool || !ADDRESS_RE.test(pool)) fail(`contracts.${poolKey} missing or not an address`);
  for (const key of ["tokenMessenger", "messageTransmitter", "usdc"] as const) {
    const addr = m.cctp?.[key];
    if (!addr || !ADDRESS_RE.test(addr)) fail(`cctp.${key} missing or not an address`);
  }
  if (m.contracts.hookRouter && !ADDRESS_RE.test(m.contracts.hookRouter)) {
    fail("contracts.hookRouter is not an address");
  }
}

/** Optional: hub yield adapter (target allowlist member in v1). Absent file => null. */
export function loadYieldManifest(deploymentsRoot: string, network: string): YieldManifest | null {
  const path = join(deploymentsRoot, yieldManifestFile(network));
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as YieldManifest;
  } catch (err) {
    throw new Error(`Unparseable yield manifest ${path}: ${(err as Error).message}`);
  }
}

export interface ChainDeployment {
  chain: ChainTopology;
  manifest: DeploymentManifest;
}

export function loadAllManifests(
  deploymentsRoot: string,
  topology: NetworkTopology,
): ChainDeployment[] {
  return allChains(topology).map((chain) => ({
    chain,
    manifest: loadManifest(deploymentsRoot, topology.network, chain),
  }));
}

/** Pool address (hub) or pool-client address (client) — the CCTP mint recipient (§8.5). */
export function poolAddress(d: ChainDeployment): string {
  return d.chain.role === "hub"
    ? d.manifest.contracts.privacyPool!
    : d.manifest.contracts.privacyPoolClient!;
}

/** Gasless wrapper for a chain: hub GaslessShieldWrapper / client GaslessShieldWrapperClient. */
export function gaslessWrapperAddress(d: ChainDeployment): string | null {
  return (
    (d.chain.role === "hub"
      ? d.manifest.contracts.gaslessShieldWrapper
      : d.manifest.contracts.gaslessShieldWrapperClient) ?? null
  );
}
