// ABOUTME: Ponder configuration derived from deployments/ manifests at config-build time (§7.2):
// ABOUTME: chains from NETWORK env, addresses/startBlock never hardcoded, per-chain poll cadence.
import { createConfig } from "ponder";
import { join } from "node:path";
import { resolveChains } from "./src/lib/manifests";
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

export default createConfig({
  chains,
  contracts: {
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
      chain: Object.fromEntries(
        resolved.map((c) => [
          c.name,
          {
            address: c.manifest.cctp.messageTransmitter as `0x${string}`,
            startBlock: c.manifest.deployBlock ?? 0,
          },
        ]),
      ),
    },
  },
});
