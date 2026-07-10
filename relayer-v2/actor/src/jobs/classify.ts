// ABOUTME: Fail-closed CCTP MessageSent classification ported verbatim from v1
// ABOUTME: iris-relay.ts classifyMessageForRelay (offsets, checks, and reason strings preserved).
import { getBytes, dataSlice, zeroPadValue, getAddress } from "ethers";

export type ClassifyResult =
  | { relay: true; mintRecipient: string }
  | { relay: false; reason: string };

// MessageV2 envelope offsets (bytes) — contracts/cctp/ICCTPV2.sol:
//   version[0..4) sourceDomain[4..8) destinationDomain[8..12) nonce[12..44) sender[44..76)
//   recipient[76..108) destinationCaller[108..140) minFinalityThreshold[140..144)
//   finalityThresholdExecuted[144..148) messageBody[148..)
// BurnMessageV2 body: version@0 (abs 148), burnToken@4, mintRecipient@36 (abs 184),
//   amount@68, messageSender@100, maxFee@132, feeExecuted@164, expirationBlock@196; min 228.
const MSG_DEST_CALLER_OFFSET = 108;
const MSG_DEST_CALLER_LENGTH = 32;
const MSG_BODY_OFFSET = 148;
const BURN_MSG_MINT_RECIPIENT_OFFSET = 36;
const MINT_RECIPIENT_ABSOLUTE_OFFSET = MSG_BODY_OFFSET + BURN_MSG_MINT_RECIPIENT_OFFSET; // 184
const MINT_RECIPIENT_LENGTH = 32;
const BURN_MSG_MIN_BODY_BYTES = 228;
export const MIN_MESSAGE_LENGTH_BYTES = MSG_BODY_OFFSET + BURN_MSG_MIN_BODY_BYTES; // 376
const BURN_MESSAGE_VERSION = 1;
const ZERO_CALLER = "0x" + "0".repeat(64);

/** Left-pads a 20-byte address into the bytes32 form CCTP uses for recipients. */
export function addressToBytes32(address: string): string {
  return zeroPadValue(getAddress(address), 32).toLowerCase();
}

/**
 * Classifies a raw CCTP message for relay eligibility — ported from v1 (iris-relay.ts:276).
 * Every check fails closed except the v1 destinationCaller nuance: a non-zero caller is only
 * rejected when a hookRouter IS configured (v1 code wins over the spec's stricter reading).
 */
export function classifyMessageForRelay(
  messageHex: string,
  knownRecipients: ReadonlySet<string>,
  hookRouter: string | null,
): ClassifyResult {
  const hex = messageHex.startsWith("0x") ? messageHex.slice(2) : messageHex;
  if (!/^[0-9a-fA-F]*$/.test(hex)) {
    return { relay: false, reason: "unparseable message hex" };
  }
  const byteLen = Math.floor(hex.length / 2);

  if (byteLen < MIN_MESSAGE_LENGTH_BYTES) {
    return {
      relay: false,
      reason: `not a BurnMessageV2 — ${byteLen}B < ${MIN_MESSAGE_LENGTH_BYTES}B minimum`,
    };
  }
  const bodyVersion = parseInt(hex.slice(MSG_BODY_OFFSET * 2, (MSG_BODY_OFFSET + 4) * 2), 16);
  if (bodyVersion !== BURN_MESSAGE_VERSION) {
    return {
      relay: false,
      reason: `body version ${bodyVersion} != BurnMessageV2 v${BURN_MESSAGE_VERSION}`,
    };
  }
  const mintRecipient =
    "0x" +
    hex
      .slice(
        MINT_RECIPIENT_ABSOLUTE_OFFSET * 2,
        (MINT_RECIPIENT_ABSOLUTE_OFFSET + MINT_RECIPIENT_LENGTH) * 2,
      )
      .toLowerCase();
  if (knownRecipients.size === 0) {
    return {
      relay: false,
      reason: `no known recipients configured for destination — refusing to relay (check deployment file)`,
    };
  }
  if (!knownRecipients.has(mintRecipient)) {
    return { relay: false, reason: `mintRecipient ${mintRecipient} not in knownRecipients` };
  }
  const destinationCaller =
    "0x" +
    hex
      .slice(MSG_DEST_CALLER_OFFSET * 2, (MSG_DEST_CALLER_OFFSET + MSG_DEST_CALLER_LENGTH) * 2)
      .toLowerCase();
  if (destinationCaller !== ZERO_CALLER && hookRouter) {
    const ourHookRouterBytes32 = zeroPadValue(hookRouter, 32).toLowerCase();
    if (destinationCaller !== ourHookRouterBytes32) {
      return {
        relay: false,
        reason: `destinationCaller ${destinationCaller.slice(0, 20)}... is set but != our hookRouter`,
      };
    }
  }
  return { relay: true, mintRecipient };
}

/** Header fields the job table needs, decoded without any relay judgment. */
export interface MessageHeader {
  sourceDomain: number;
  destinationDomain: number;
  nonce: string; // bytes32 hex (zero at source in CCTP V2)
}

function uint32At(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>>
    0
  );
}

export function decodeMessageHeader(messageHex: string): MessageHeader {
  const bytes = getBytes(messageHex);
  if (bytes.length < MSG_BODY_OFFSET) {
    throw new Error(`message too short for CCTP V2 header: ${bytes.length} bytes`);
  }
  return {
    sourceDomain: uint32At(bytes, 4),
    destinationDomain: uint32At(bytes, 8),
    nonce: dataSlice(bytes, 12, 44).toLowerCase(),
  };
}
