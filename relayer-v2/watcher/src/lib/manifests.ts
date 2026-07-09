// ABOUTME: Watcher-side network topology + deployment-manifest loader (§7.2). Kept dependency-
// ABOUTME: independent from the actor package (spec §4.2); same manifest schema (DEV-2).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type NetworkName = "local" | "sepolia" | "mainnet";

export interface WatcherChain {
  chainId: number;
  name: string;
  role: "hub" | "client";
  domain: number;
  rpcUrlEnv: string;
  defaultRpcUrl?: string;
  pollingIntervalMs: number;
  confirmations: number;
}

const CHAINS: Record<NetworkName, WatcherChain[]> = {
  local: [
    { chainId: 31337, name: "hub", role: "hub", domain: 100, rpcUrlEnv: "RPC_URL_31337", defaultRpcUrl: "http://127.0.0.1:8545", pollingIntervalMs: 1000, confirmations: 0 },
    { chainId: 31338, name: "clientA", role: "client", domain: 101, rpcUrlEnv: "RPC_URL_31338", defaultRpcUrl: "http://127.0.0.1:8546", pollingIntervalMs: 1000, confirmations: 0 },
    { chainId: 31339, name: "clientB", role: "client", domain: 102, rpcUrlEnv: "RPC_URL_31339", defaultRpcUrl: "http://127.0.0.1:8547", pollingIntervalMs: 1000, confirmations: 0 },
  ],
  sepolia: [
    { chainId: 11155111, name: "hub", role: "hub", domain: 0, rpcUrlEnv: "RPC_URL_11155111", pollingIntervalMs: 12000, confirmations: 6 },
    { chainId: 84532, name: "clientA", role: "client", domain: 6, rpcUrlEnv: "RPC_URL_84532", pollingIntervalMs: 5000, confirmations: 2 },
    { chainId: 421614, name: "clientB", role: "client", domain: 3, rpcUrlEnv: "RPC_URL_421614", pollingIntervalMs: 5000, confirmations: 2 },
  ],
  mainnet: [
    { chainId: 1, name: "hub", role: "hub", domain: 0, rpcUrlEnv: "RPC_URL_1", pollingIntervalMs: 12000, confirmations: 6 },
    { chainId: 8453, name: "clientA", role: "client", domain: 6, rpcUrlEnv: "RPC_URL_8453", pollingIntervalMs: 5000, confirmations: 2 },
    { chainId: 42161, name: "clientB", role: "client", domain: 3, rpcUrlEnv: "RPC_URL_42161", pollingIntervalMs: 5000, confirmations: 2 },
  ],
};

export interface Manifest {
  schemaVersion: number;
  chainId: number;
  domain: number;
  role: "hub" | "client";
  deployBlock: number;
  contracts: Record<string, string>;
}

export interface ResolvedChain extends WatcherChain {
  rpcUrl: string;
  manifest: Manifest;
}

export function networkName(env: NodeJS.ProcessEnv): NetworkName {
  const network = env.NETWORK ?? "local";
  if (network !== "local" && network !== "sepolia" && network !== "mainnet") {
    throw new Error(`NETWORK must be one of local|sepolia|mainnet, got ${JSON.stringify(network)}`);
  }
  return network;
}

export function resolveChains(env: NodeJS.ProcessEnv, deploymentsRoot: string): ResolvedChain[] {
  const network = networkName(env);
  return CHAINS[network].map((chain) => {
    const rpcUrl = env[chain.rpcUrlEnv] ?? chain.defaultRpcUrl;
    if (!rpcUrl) {
      throw new Error(`Missing RPC URL for chain ${chain.chainId}: set ${chain.rpcUrlEnv}`);
    }
    const file = chain.role === "hub" ? "hub.json" : `client-${chain.chainId}.json`;
    const path = join(deploymentsRoot, network, file);
    if (!existsSync(path)) {
      throw new Error(
        `Missing deployment manifest for NETWORK=${network} chainId=${chain.chainId}: ` +
          `expected ${path} (spec §7.2 — manifests are the single source of truth).`,
      );
    }
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
    if (manifest.chainId !== chain.chainId || manifest.domain !== chain.domain) {
      throw new Error(`Manifest ${path} chainId/domain does not match topology`);
    }
    const poolKey = chain.role === "hub" ? "privacyPool" : "privacyPoolClient";
    for (const key of [poolKey, "messageTransmitter", "hookRouter", "wrapper"]) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(manifest.contracts[key] ?? "")) {
        throw new Error(`Manifest ${path} missing contracts.${key}`);
      }
    }
    return { ...chain, rpcUrl, manifest };
  });
}

/** Per-chain allowlist of indexed protocol contract addresses, for /v1/logs (P1). */
export function protocolAddressAllowlist(chains: ResolvedChain[]): Map<number, Set<string>> {
  const map = new Map<number, Set<string>>();
  for (const chain of chains) {
    map.set(
      chain.chainId,
      new Set(Object.values(chain.manifest.contracts).map((a) => a.toLowerCase())),
    );
  }
  return map;
}
