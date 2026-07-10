// ABOUTME: Loads privacy-pool deployment manifests from either the central registry
// ABOUTME: (ship-armada/armada-deployments layout) or flat local files (monorepo e2e). §7.2.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ChainTopology, NetworkTopology } from "./networks.js";
import { allChains } from "./networks.js";

/** Real manifest shape — identical in the registry's `<chain>/privacy-pool.json` and the
 * monorepo's flat `privacy-pool-*.json` (only the file location differs). */
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

/** Hub yield manifest — supplies the ArmadaYieldAdapter for the hub target allowlist. */
export interface YieldManifest {
  chainId: number;
  contracts: { armadaYieldVault?: string; armadaYieldAdapter?: string };
}

/** Registry instance index (`<environment>/<instance>/manifest.json`). */
interface InstanceManifest {
  name: string;
  environment: string;
  chains: Record<string, { chainId: number; role: "hub" | "client"; artifacts?: string[] }>;
}

/**
 * Where manifests come from:
 *  - `flat`: monorepo-style `privacy-pool-{prefix}{-env}.json` in one dir (local e2e).
 *  - `registry`: central-repo layout `<environment>/<instance>/<chain-slug>/privacy-pool.json`.
 */
export type DeploymentSource =
  | { kind: "flat"; root: string }
  | { kind: "registry"; root: string; environment: string; instance: string };

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** File-name suffix per network — monorepo convention: "" local, "-sepolia", "-mainnet". */
export function networkSuffix(network: string): string {
  return network === "local" ? "" : `-${network}`;
}

// ---- shared parse + validate (identical for both sources) ----

function readManifest(path: string, describe: string, chain: ChainTopology): DeploymentManifest {
  if (!existsSync(path)) {
    throw new Error(
      `Missing deployment manifest for ${describe} (chainId=${chain.chainId}): expected ${path}. ` +
        `Manifests are the single source of truth for addresses and deployBlock (spec §7.2); ` +
        `refusing to boot without one.`,
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

// ---- flat provider (local / monorepo e2e) ----

function flatPoolPath(root: string, network: string, chain: ChainTopology): string {
  return join(root, `privacy-pool-${chain.manifestPrefix}${networkSuffix(network)}.json`);
}

function flatYieldPath(root: string, network: string): string {
  return join(root, `yield-hub${networkSuffix(network)}.json`);
}

// ---- registry provider (central repo) ----

function loadInstance(source: { root: string; environment: string; instance: string }): {
  manifest: InstanceManifest;
  dir: string;
} {
  const dir = join(source.root, source.environment, source.instance);
  const path = join(dir, "manifest.json");
  if (!existsSync(path)) {
    throw new Error(
      `Missing deployment registry instance: expected ${path}. Set DEPLOYMENT_INSTANCE to a ` +
        `published instance under ${source.environment}/ in the armada-deployments registry ` +
        `(and run \`git submodule update --init deployments/registry\`).`,
    );
  }
  let manifest: InstanceManifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Unparseable registry instance manifest ${path}: ${(err as Error).message}`);
  }
  return { manifest, dir };
}

/** Finds the registry chain-slug directory for a topology chain, matched by chainId (never by
 * slug name — the registry names chains freely, e.g. base-sepolia). Cross-checks role. */
function registrySlugForChain(manifest: InstanceManifest, chain: ChainTopology): string {
  const entry = Object.entries(manifest.chains).find(([, c]) => c.chainId === chain.chainId);
  if (!entry) {
    throw new Error(
      `Registry instance "${manifest.name}" has no chain with chainId ${chain.chainId} ` +
        `(topology expects ${chain.name}). Available: ${Object.values(manifest.chains)
          .map((c) => c.chainId)
          .join(", ")}`,
    );
  }
  const [slug, meta] = entry;
  if (meta.role !== chain.role) {
    throw new Error(
      `Registry chain ${slug} (chainId ${chain.chainId}) has role "${meta.role}" but the ` +
        `topology expects "${chain.role}".`,
    );
  }
  return slug;
}

// ---- public API ----

export interface ChainDeployment {
  chain: ChainTopology;
  manifest: DeploymentManifest;
}

export function loadAllManifests(
  source: DeploymentSource,
  topology: NetworkTopology,
): ChainDeployment[] {
  if (source.kind === "flat") {
    return allChains(topology).map((chain) => ({
      chain,
      manifest: readManifest(
        flatPoolPath(source.root, topology.network, chain),
        `NETWORK=${topology.network}`,
        chain,
      ),
    }));
  }
  const { manifest, dir } = loadInstance(source);
  return allChains(topology).map((chain) => {
    const slug = registrySlugForChain(manifest, chain);
    return {
      chain,
      manifest: readManifest(
        join(dir, slug, "privacy-pool.json"),
        `instance=${source.instance} chain=${slug}`,
        chain,
      ),
    };
  });
}

/** Hub yield adapter (target allowlist member). Absent file => null (optional). */
export function loadYieldManifest(
  source: DeploymentSource,
  topology: NetworkTopology,
): YieldManifest | null {
  let path: string;
  if (source.kind === "flat") {
    path = flatYieldPath(source.root, topology.network);
  } else {
    const { manifest, dir } = loadInstance(source);
    const slug = registrySlugForChain(manifest, topology.hub);
    path = join(dir, slug, "yield.json");
  }
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as YieldManifest;
  } catch (err) {
    throw new Error(`Unparseable yield manifest ${path}: ${(err as Error).message}`);
  }
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
