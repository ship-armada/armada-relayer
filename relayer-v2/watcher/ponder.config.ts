// ABOUTME: Ponder configuration derived from deployments/ manifests at config-build time (§7.2):
// ABOUTME: chains from NETWORK env, addresses/startBlock never hardcoded, per-chain poll cadence.
import { createConfig } from "ponder";
import { join } from "node:path";
import { resolveChains, messageTransmitterChain, watcherMode } from "./src/lib/manifests";
import { PrivacyPoolAbi } from "./abis/PrivacyPool";
import { PrivacyPoolClientAbi } from "./abis/PrivacyPoolClient";
import { MessageTransmitterAbi } from "./abis/MessageTransmitter";

const deploymentsRoot = process.env.DEPLOYMENTS_DIR ?? join(process.cwd(), "..", "..", "deployments");
const resolved = resolveChains(process.env, deploymentsRoot);

const hub = resolved.find((c) => c.role === "hub")!;
const clients = resolved.filter((c) => c.role === "client");

const chains = Object.fromEntries(
  resolved.map((c) => [
    c.name,
    {
      id: c.chainId,
      rpc: c.rpcUrls,
      pollingInterval: Number(process.env[`POLLING_INTERVAL_${c.chainId}`] ?? c.pollingIntervalMs),
    },
  ]),
);

// Full contract set. In cctp-only mode the pool contracts are dropped from the runtime *value*
// below (no backfill, no pool tables), but their keys stay in this *type* — Ponder derives the
// ponder.on() event names from the config type, so the pool indexing handlers in src/index.ts
// keep type-checking under CI's default (full) typecheck. src/index.ts's poolIndexing guard is
// what stops those handlers from actually registering when the contracts are absent at runtime.
const allContracts = {
  PrivacyPool: {
    abi: PrivacyPoolAbi,
    chain: {
      [hub.name]: {
        address: hub.manifest.contracts.privacyPool as `0x${string}`,
        startBlock: hub.manifest.deployBlock ?? 0,
      },
    },
  },
  PrivacyPoolClient: {
    abi: PrivacyPoolClientAbi,
    chain: Object.fromEntries(
      clients.map((c) => [
        c.name,
        {
          address: c.manifest.contracts.privacyPoolClient as `0x${string}`,
          startBlock: c.manifest.deployBlock ?? 0,
        },
      ]),
    ),
  },
  MessageTransmitter: {
    abi: MessageTransmitterAbi,
    // CCTP is indexed forward-only (§8.3): the pools above backfill from deployBlock for
    // quick-sync, but relayable CCTP messages are only ever in-flight, so the transmitter
    // starts at cctpStartBlock (default "latest") to avoid replaying Circle's chain-wide burn
    // firehose since deploy. MessageSent has no indexed args (can't narrow by recipient) so it
    // is indexed in full; MessageReceived's `caller` IS indexed, and our destination relays
    // route through the HookRouter, so filtering caller = hookRouter keeps only our own
    // deliveries (the actor's already_delivered lookahead; third-party deliveries are backstopped
    // by on-chain replay protection, D4). Chains without a hookRouter index MessageReceived unfiltered.
    chain: Object.fromEntries(
      resolved.map((c) => [c.name, messageTransmitterChain(process.env, c)]),
    ),
  },
};

// cctp-only: index ONLY the CCTP transmitter (from "latest") — no pool backfill/indexing and no
// quick-sync — so the watcher's per-chain checkpoint reaches head immediately. The cast keeps the
// exported config type stable (all contract keys present); the runtime value carries only the
// contracts this mode indexes, matched by the handler guard in src/index.ts.
const contracts: typeof allContracts =
  watcherMode(process.env) === "full"
    ? allContracts
    : ({ MessageTransmitter: allContracts.MessageTransmitter } as typeof allContracts);

export default createConfig({ chains, contracts });
