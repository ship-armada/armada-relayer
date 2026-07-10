// ABOUTME: Wires the state machine's DestinationSubmitter to the wallet manager: relayWithHook
// ABOUTME: via CCTPHookRouter, receiveMessage fallback, receipt + mempool polling (v1 submitRelay).
import { Interface } from "ethers";
import type { WalletManager } from "../wallet/wallet-manager.js";
import type { DestinationSubmitter, ReceiptInfo } from "./state-machine.js";
import type { ActorMetrics } from "../metrics.js";

// contracts/cctp/CCTPHookRouter.sol:42 — verified against the monorepo source.
const HOOK_ROUTER_IFACE = new Interface([
  "function relayWithHook(bytes calldata message, bytes calldata attestation) external returns (bool)",
]);
// v1 REAL_MESSAGE_TRANSMITTER_ABI fallback when no hookRouter is configured.
const MESSAGE_TRANSMITTER_IFACE = new Interface([
  "function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool)",
]);

export interface DomainTarget {
  chainId: number;
  hookRouter: string | null;
  messageTransmitter: string;
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
      const { chainId, hookRouter, messageTransmitter } = chainOf(domain);
      const call = hookRouter
        ? {
            to: hookRouter,
            data: HOOK_ROUTER_IFACE.encodeFunctionData("relayWithHook", [
              messageBytes,
              attestation,
            ]),
          }
        : {
            to: messageTransmitter,
            data: MESSAGE_TRANSMITTER_IFACE.encodeFunctionData("receiveMessage", [
              messageBytes,
              attestation,
            ]),
          };
      metrics?.rpcRequest(chainId, "eth_sendRawTransaction");
      const tx = await wallet.submit(chainId, call);
      return { hash: tx.hash };
    },

    async getReceipt(domain, txHash): Promise<ReceiptInfo | null> {
      const { chainId } = chainOf(domain);
      metrics?.rpcRequest(chainId, "eth_getTransactionReceipt");
      const receipt = await wallet.provider(chainId).getTransactionReceipt(txHash);
      if (!receipt) return null;
      return { status: receipt.status ?? 0, blockNumber: BigInt(receipt.blockNumber) };
    },

    async isInMempool(domain, txHash): Promise<boolean> {
      const { chainId } = chainOf(domain);
      metrics?.rpcRequest(chainId, "eth_getTransactionByHash");
      const tx = await wallet.provider(chainId).getTransaction(txHash);
      return tx !== null;
    },

    resetNonce(domain) {
      wallet.nonces.reset(chainOf(domain).chainId);
    },
  };
}
