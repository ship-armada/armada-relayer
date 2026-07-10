// ABOUTME: Static network topology for local|sepolia|mainnet per spec §7.2 — chain IDs,
// ABOUTME: CCTP domains, Iris URLs, poll intervals, confirmation depths, RPC env var names.

export type NetworkName = "local" | "sepolia" | "mainnet";

export type ChainRole = "hub" | "client";

/** Manifest file-name prefix — v1 convention: hub / client / clientB (historical, not client2). */
export type ManifestPrefix = "hub" | "client" | "clientB";

export interface ChainTopology {
  chainId: number;
  name: string;
  role: ChainRole;
  manifestPrefix: ManifestPrefix;
  domain: number;
  rpcUrlEnv: string; // env var holding the RPC URL (may embed a paid key => secret)
  defaultRpcUrl?: string; // only local mode has committed defaults
  pollingIntervalMs: number; // watcher poll cadence; also health freshness base (§6.6)
  confirmations: number; // L1: 6, L2: 2, local: 0 (§7.2)
  nominalBlockTimeMs: number; // used to estimate lagBlocks from timestamp lag
}

export interface NetworkTopology {
  network: NetworkName;
  irisMode: "mock" | "iris";
  irisBaseUrl: string | null;
  hub: ChainTopology;
  clients: ChainTopology[];
}

const TOPOLOGIES: Record<NetworkName, NetworkTopology> = {
  local: {
    network: "local",
    irisMode: "mock",
    irisBaseUrl: null,
    hub: {
      chainId: 31337,
      name: "anvil-hub",
      role: "hub",
      manifestPrefix: "hub",
      domain: 100,
      rpcUrlEnv: "HUB_RPC",
      defaultRpcUrl: "http://127.0.0.1:8545",
      pollingIntervalMs: 1000,
      confirmations: 0,
      nominalBlockTimeMs: 1000,
    },
    clients: [
      {
        chainId: 31338,
        name: "anvil-client-a",
        role: "client",
        manifestPrefix: "client",
        domain: 101,
        rpcUrlEnv: "CLIENT_A_RPC",
        defaultRpcUrl: "http://127.0.0.1:8546",
        pollingIntervalMs: 1000,
        confirmations: 0,
        nominalBlockTimeMs: 1000,
      },
      {
        chainId: 31339,
        name: "anvil-client-b",
        role: "client",
        manifestPrefix: "clientB",
        domain: 102,
        rpcUrlEnv: "CLIENT_B_RPC",
        defaultRpcUrl: "http://127.0.0.1:8547",
        pollingIntervalMs: 1000,
        confirmations: 0,
        nominalBlockTimeMs: 1000,
      },
    ],
  },
  sepolia: {
    network: "sepolia",
    irisMode: "iris",
    irisBaseUrl: "https://iris-api-sandbox.circle.com",
    hub: {
      chainId: 11155111,
      name: "ethereum-sepolia",
      role: "hub",
      manifestPrefix: "hub",
      domain: 0,
      rpcUrlEnv: "HUB_RPC",
      pollingIntervalMs: 12000,
      confirmations: 6,
      nominalBlockTimeMs: 12000,
    },
    clients: [
      {
        chainId: 84532,
        name: "base-sepolia",
        role: "client",
        manifestPrefix: "client",
        domain: 6,
        rpcUrlEnv: "CLIENT_A_RPC",
        pollingIntervalMs: 5000,
        confirmations: 2,
        nominalBlockTimeMs: 2000,
      },
      {
        chainId: 421614,
        name: "arbitrum-sepolia",
        role: "client",
        manifestPrefix: "clientB",
        domain: 3,
        rpcUrlEnv: "CLIENT_B_RPC",
        pollingIntervalMs: 5000,
        confirmations: 2,
        nominalBlockTimeMs: 250,
      },
    ],
  },
  mainnet: {
    network: "mainnet",
    irisMode: "iris",
    irisBaseUrl: "https://iris-api.circle.com",
    hub: {
      chainId: 1,
      name: "ethereum",
      role: "hub",
      manifestPrefix: "hub",
      domain: 0,
      rpcUrlEnv: "HUB_RPC",
      pollingIntervalMs: 12000,
      confirmations: 6,
      nominalBlockTimeMs: 12000,
    },
    // Pairing mirrors sepolia; MUST be re-confirmed against the Launch-2 deployment
    // plan before mainnet manifests are authored (spec §7.2).
    clients: [
      {
        chainId: 8453,
        name: "base",
        role: "client",
        manifestPrefix: "client",
        domain: 6,
        rpcUrlEnv: "CLIENT_A_RPC",
        pollingIntervalMs: 5000,
        confirmations: 2,
        nominalBlockTimeMs: 2000,
      },
      {
        chainId: 42161,
        name: "arbitrum-one",
        role: "client",
        manifestPrefix: "clientB",
        domain: 3,
        rpcUrlEnv: "CLIENT_B_RPC",
        pollingIntervalMs: 5000,
        confirmations: 2,
        nominalBlockTimeMs: 250,
      },
    ],
  },
};

export function getTopology(network: string): NetworkTopology {
  if (network !== "local" && network !== "sepolia" && network !== "mainnet") {
    throw new Error(
      `NETWORK must be one of local|sepolia|mainnet, got ${JSON.stringify(network)}`,
    );
  }
  return TOPOLOGIES[network];
}

export function allChains(t: NetworkTopology): ChainTopology[] {
  return [t.hub, ...t.clients];
}

/** Asserts the domain/chain pairing invariants that must hold on every network (§7.2). */
export function assertDomainPairing(t: NetworkTopology): void {
  const domains = allChains(t).map((c) => c.domain);
  if (new Set(domains).size !== domains.length) {
    throw new Error(`duplicate CCTP domains in ${t.network} topology: ${domains.join(",")}`);
  }
  const chainIds = allChains(t).map((c) => c.chainId);
  if (new Set(chainIds).size !== chainIds.length) {
    throw new Error(`duplicate chainIds in ${t.network} topology`);
  }
  if (t.network !== "local") {
    if (t.hub.domain !== 0) throw new Error(`${t.network} hub must be CCTP domain 0`);
    if (t.irisBaseUrl === null) throw new Error(`${t.network} requires an Iris base URL`);
  }
}
