// ABOUTME: Loads and validates deployment manifests from deployments/<network>/ — the single
// ABOUTME: source of truth for contract addresses and deployBlock (spec §7.2); fails loudly when missing.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ChainTopology, NetworkTopology } from "./networks.js";
import { allChains } from "./networks.js";

export interface DeploymentManifest {
  schemaVersion: number;
  network: string;
  role: "hub" | "client";
  chainId: number;
  domain: number;
  deployBlock: number;
  contracts: {
    privacyPool?: string;
    privacyPoolClient?: string;
    wrapper: string;
    hookRouter: string;
    messageTransmitter: string;
    usdc: string;
  };
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function manifestPath(root: string, network: string, chain: ChainTopology): string {
  const file = chain.role === "hub" ? "hub.json" : `client-${chain.chainId}.json`;
  return join(root, network, file);
}

export function loadManifest(
  deploymentsRoot: string,
  network: string,
  chain: ChainTopology,
): DeploymentManifest {
  const path = manifestPath(deploymentsRoot, network, chain);
  if (!existsSync(path)) {
    throw new Error(
      `Missing deployment manifest for NETWORK=${network} chainId=${chain.chainId}: ` +
        `expected ${path}. Manifests under deployments/ are the single source of truth ` +
        `for addresses and deployBlock (spec §7.2); refusing to boot without one.`,
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
  if (m.schemaVersion !== 1) fail(`unsupported schemaVersion ${m.schemaVersion}`);
  if (m.chainId !== chain.chainId) fail(`chainId ${m.chainId} != expected ${chain.chainId}`);
  if (m.domain !== chain.domain) fail(`domain ${m.domain} != expected ${chain.domain}`);
  if (m.role !== chain.role) fail(`role ${m.role} != expected ${chain.role}`);
  if (!Number.isInteger(m.deployBlock) || m.deployBlock < 0) {
    fail(`deployBlock must be a non-negative integer, got ${m.deployBlock}`);
  }
  const poolKey = chain.role === "hub" ? "privacyPool" : "privacyPoolClient";
  const required = [poolKey, "wrapper", "hookRouter", "messageTransmitter", "usdc"] as const;
  for (const key of required) {
    const addr = (m.contracts as Record<string, string | undefined>)[key];
    if (!addr || !ADDRESS_RE.test(addr)) fail(`contracts.${key} missing or not an address`);
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
