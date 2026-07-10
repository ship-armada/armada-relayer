// ABOUTME: Pure decode helpers for indexing: CCTP V2 message header fields and the raw-log
// ABOUTME: envelope shapes stored verbatim for the read API (§5.1 rawData/rawTopics).
import { keccak256 } from "viem";

export interface CctpHeader {
  sourceDomain: number;
  destinationDomain: number;
  nonce: `0x${string}`;
}

/** CCTP V2 header: version[0..4) sourceDomain[4..8) destinationDomain[8..12) nonce[12..44). */
export function decodeCctpHeader(messageHex: string): CctpHeader {
  const hex = messageHex.startsWith("0x") ? messageHex.slice(2) : messageHex;
  if (hex.length < 88) {
    throw new Error(`message too short for CCTP V2 header: ${hex.length / 2} bytes`);
  }
  return {
    sourceDomain: Number.parseInt(hex.slice(8, 16), 16),
    destinationDomain: Number.parseInt(hex.slice(16, 24), 16),
    nonce: `0x${hex.slice(24, 88)}` as `0x${string}`,
  };
}

export function messageHashOf(messageHex: `0x${string}`): `0x${string}` {
  return keccak256(messageHex);
}

/** Canonical log identifier: `${chainId}:${txHash}:${logIndex}` (§5.1 id columns). */
export function logRowId(chainId: number, txHash: string, logIndex: number): string {
  return `${chainId}:${txHash}:${logIndex}`;
}

/** CCTP dedupKey preserved from v1: `${sourceTxHash}:${logIndex}` (§3). */
export function dedupKey(txHash: string, logIndex: number): string {
  return `${txHash}:${logIndex}`;
}

export function serializeTopics(topics: readonly string[]): string {
  return JSON.stringify(topics);
}
