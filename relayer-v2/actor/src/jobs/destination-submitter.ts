// ABOUTME: Wires the state machine's DestinationSubmitter to the wallet manager and the
// ABOUTME: per-domain HookRouter contracts (relayWithHook broadcast + own-tx receipt polling).
import { Interface } from "ethers";
import type { WalletManager } from "../wallet/wallet-manager.js";
import type { DestinationSubmitter, ReceiptInfo } from "./state-machine.js";
import type { ActorMetrics } from "../metrics.js";

// ASSUMED HookRouter ABI (DEV-4 family): v1 broadcasts `relayWithHook`; exact signature
// unavailable in this workspace. Regenerate from real artifacts and diff before cutover.
const HOOK_ROUTER_IFACE = new Interface([
  "function relayWithHook(bytes message, bytes attestation)",
]);

export interface DomainTarget {
  chainId: number;
  hookRouter: string;
}

export function createDestinationSubmitter(
  wallet: WalletManager,
  domainTargets: Map<number, DomainTarget>,
  metrics?: ActorMetrics,
): DestinationSubmitter {
  const chainOf = (domain: number): DomainTarget => {
    const target = domainTargets.get(domain);
    if (!target) throw new Error(`no destination configured for CCTP domain ${domain}`);
    return target;
  };

  return {
    async submitRelayWithHook(domain, messageBytes, attestation) {
      const { chainId, hookRouter } = chainOf(domain);
      const data = HOOK_ROUTER_IFACE.encodeFunctionData("relayWithHook", [
        messageBytes,
        attestation,
      ]);
      metrics?.rpcRequest(chainId, "eth_sendRawTransaction");
      const tx = await wallet.submit(chainId, { to: hookRouter, data });
      return { hash: tx.hash };
    },

    async getReceipt(domain, txHash): Promise<ReceiptInfo | null> {
      const { chainId } = chainOf(domain);
      metrics?.rpcRequest(chainId, "eth_getTransactionReceipt");
      const receipt = await wallet.provider(chainId).getTransactionReceipt(txHash);
      if (!receipt) return null;
      return { status: receipt.status ?? 0, blockNumber: BigInt(receipt.blockNumber) };
    },

    resetNonce(domain) {
      wallet.nonces.reset(chainOf(domain).chainId);
    },
  };
}
