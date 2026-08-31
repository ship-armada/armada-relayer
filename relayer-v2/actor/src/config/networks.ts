// ABOUTME: Network topology loader (spec §7.2) — one hub + N clients per network, read from
// ABOUTME: deployments/topology.json at boot; ENABLED_CLIENTS selects a subset of the clients.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type NetworkName = "local" | "sepolia" | "mainnet";

export type ChainRole = "hub" | "client";

/** Manifest file-name stem — monorepo flat manifests are privacy-pool-<prefix>{-env}.json.
 * Free-form: each client names its own stem (historically hub / client / clientB). */
export type ManifestPrefix = string;

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

/** Raw per-chain shape as written in topology.json (no `role` — assigned by position). */
interface RawChain {
  chainId: number;
  name: string;
  domain: number;
  rpcUrlEnv: string;
  defaultRpcUrl?: string;
  manifestPrefix: string;
  pollingIntervalMs: number;
  confirmations: number;
  nominalBlockTimeMs: number;
}

interface RawNetwork {
  irisMode: "mock" | "iris";
  irisBaseUrl: string | null;
  hub: RawChain;
  clients: RawChain[];
}

/** Parsed topology.json: one entry per network name. `$comment` (docs) is ignored. */
export type TopologyFile = Record<string, RawNetwork>;

/** File name of the topology document within the deployments root. */
export const TOPOLOGY_FILE = "topology.json";

const NETWORKS: readonly NetworkName[] = ["local", "sepolia", "mainnet"];

/** NETWORK selector (DEPLOY_ENV is v1's alias); validates the value loudly. */
export function networkName(env: NodeJS.ProcessEnv): NetworkName {
  const network = env.NETWORK ?? env.DEPLOY_ENV ?? "local";
  if (!NETWORKS.includes(network as NetworkName)) {
    throw new Error(
      `NETWORK must be one of local|sepolia|mainnet, got ${JSON.stringify(network)}`,
    );
  }
  return network as NetworkName;
}

/** Reads and JSON-parses topology.json from the deployments root, failing loudly. */
export function loadTopologyFile(deploymentsRoot: string): TopologyFile {
  const path = join(deploymentsRoot, TOPOLOGY_FILE);
  if (!existsSync(path)) {
    throw new Error(
      `Missing topology file: expected ${path}. topology.json is the single source of truth ` +
        `for which chains exist per network (spec §7.2); refusing to boot without one.`,
    );
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as TopologyFile;
  } catch (err) {
    throw new Error(`Unparseable topology file ${path}: ${(err as Error).message}`);
  }
}

function toChain(raw: RawChain, role: ChainRole, network: string): ChainTopology {
  const fail = (msg: string): never => {
    throw new Error(`Invalid topology (network=${network}, role=${role}): ${msg}`);
  };
  const int = (v: unknown, key: string): number => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      fail(`${key} must be a non-negative integer, got ${JSON.stringify(v)}`);
    }
    return v as number;
  };
  const str = (v: unknown, key: string): string => {
    if (typeof v !== "string" || v.length === 0) fail(`${key} must be a non-empty string`);
    return v as string;
  };
  return {
    chainId: int(raw.chainId, "chainId"),
    name: str(raw.name, "name"),
    role,
    manifestPrefix: str(raw.manifestPrefix, "manifestPrefix"),
    domain: int(raw.domain, "domain"),
    rpcUrlEnv: str(raw.rpcUrlEnv, "rpcUrlEnv"),
    defaultRpcUrl: raw.defaultRpcUrl,
    pollingIntervalMs: int(raw.pollingIntervalMs, "pollingIntervalMs"),
    confirmations: int(raw.confirmations, "confirmations"),
    nominalBlockTimeMs: int(raw.nominalBlockTimeMs, "nominalBlockTimeMs"),
  };
}

/** Builds the full (unfiltered) topology for one network from a parsed file. */
export function buildNetworkTopology(file: TopologyFile, network: string): NetworkTopology {
  if (!NETWORKS.includes(network as NetworkName)) {
    throw new Error(
      `NETWORK must be one of local|sepolia|mainnet, got ${JSON.stringify(network)}`,
    );
  }
  const raw = file[network];
  if (!raw) throw new Error(`topology.json has no entry for NETWORK=${network}`);
  if (!raw.hub) throw new Error(`topology.json ${network} entry is missing a hub`);
  if (!Array.isArray(raw.clients)) throw new Error(`topology.json ${network} clients must be an array`);
  return {
    network: network as NetworkName,
    irisMode: raw.irisMode,
    irisBaseUrl: raw.irisBaseUrl ?? null,
    hub: toChain(raw.hub, "hub", network),
    clients: raw.clients.map((c) => toChain(c, "client", network)),
  };
}

/** Parsed ENABLED_CLIENTS (comma-separated chain names); undefined ⇒ all clients. */
export function enabledClients(env: NodeJS.ProcessEnv): string[] | undefined {
  // Compose passes unset vars as empty strings (`${VAR:-}`), so treat "" as unset.
  const raw = env.ENABLED_CLIENTS;
  if (raw === undefined || raw.trim() === "") return undefined;
  return [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0))];
}

/** Filters clients to the ENABLED_CLIENTS subset (by chain name); undefined ⇒ unchanged. */
export function selectClients(
  clients: ChainTopology[],
  enabled: string[] | undefined,
  network: string,
): ChainTopology[] {
  if (enabled === undefined) return clients;
  const byName = new Map(clients.map((c) => [c.name, c]));
  const selected = enabled.map((name) => {
    const chain = byName.get(name);
    if (!chain) {
      throw new Error(
        `ENABLED_CLIENTS names unknown client ${JSON.stringify(name)} for NETWORK=${network}; ` +
          `available: ${clients.map((c) => c.name).join(", ")}`,
      );
    }
    return chain;
  });
  if (selected.length === 0) {
    throw new Error(`ENABLED_CLIENTS selected no clients for NETWORK=${network}`);
  }
  return selected;
}

/** Runtime entry: loads the topology for env.NETWORK and applies the ENABLED_CLIENTS subset. */
export function getTopology(env: NodeJS.ProcessEnv, deploymentsRoot: string): NetworkTopology {
  const network = networkName(env);
  const topology = buildNetworkTopology(loadTopologyFile(deploymentsRoot), network);
  return {
    ...topology,
    clients: selectClients(topology.clients, enabledClients(env), network),
  };
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
