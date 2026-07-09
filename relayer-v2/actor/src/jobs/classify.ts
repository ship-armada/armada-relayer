// ABOUTME: Fail-closed CCTP MessageSent classification (spec §8.5, preserved from v1
// ABOUTME: classifyMessageForRelay): only positively-identified ours-to-relay messages pass.
import { getBytes, hexlify, getAddress, dataSlice } from "ethers";

export type ClassifyResult =
  | { relay: true; mintRecipient: string }
  | { relay: false; reason: string };

// CCTP V2 message layout (bytes):
//   header: version[0..4) sourceDomain[4..8) destinationDomain[8..12) nonce[12..44)
//           sender[44..76) recipient[76..108) destinationCaller[108..140)
//           minFinalityThreshold[140..144) finalityThresholdExecuted[144..148)
//   burn body starts at 148: version[148..152) burnToken[152..184) mintRecipient[184..216)
//           amount[216..248) messageSender[248..280) maxFee[280..312) feeExecuted[312..344)
//           expirationBlock[344..376)
export const MIN_MESSAGE_LENGTH_BYTES = 376;
const BODY_VERSION_OFFSET = 148;
const DESTINATION_CALLER_OFFSET = 108;
const MINT_RECIPIENT_OFFSET = 184;
const REQUIRED_BODY_VERSION = 1;

const ZERO_BYTES32 = "0x" + "00".repeat(32);

/** Left-pads a 20-byte address into the bytes32 form CCTP uses for recipients. */
export function addressToBytes32(address: string): string {
  const addr = getAddress(address);
  return ("0x" + "00".repeat(12) + addr.slice(2)).toLowerCase();
}

function bytes32At(bytes: Uint8Array, offset: number): string {
  return hexlify(bytes.slice(offset, offset + 32)).toLowerCase();
}

function uint32At(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>>
    0
  );
}

/**
 * Classifies a raw CCTP message for relay eligibility. Every check fails closed (D5):
 * anything not positively ours-to-relay is skipped with a reason.
 *
 * @param messageHex     raw message bytes as 0x-hex
 * @param knownRecipients set of bytes32-padded pool addresses (lowercase). Empty ⇒ relay nothing.
 * @param hookRouter     configured HookRouter address for the destination, or null
 */
export function classifyMessageForRelay(
  messageHex: string,
  knownRecipients: ReadonlySet<string>,
  hookRouter: string | null,
): ClassifyResult {
  let bytes: Uint8Array;
  try {
    bytes = getBytes(messageHex);
  } catch {
    return { relay: false, reason: "unparseable_message" };
  }
  if (bytes.length < MIN_MESSAGE_LENGTH_BYTES) {
    return { relay: false, reason: `too_short:${bytes.length}` };
  }
  const bodyVersion = uint32At(bytes, BODY_VERSION_OFFSET);
  if (bodyVersion !== REQUIRED_BODY_VERSION) {
    return { relay: false, reason: `body_version:${bodyVersion}` };
  }
  if (knownRecipients.size === 0) {
    return { relay: false, reason: "no_known_recipients" };
  }
  const mintRecipient = bytes32At(bytes, MINT_RECIPIENT_OFFSET);
  if (!knownRecipients.has(mintRecipient)) {
    return { relay: false, reason: "unknown_mint_recipient" };
  }
  const destinationCaller = bytes32At(bytes, DESTINATION_CALLER_OFFSET);
  if (destinationCaller !== ZERO_BYTES32) {
    if (!hookRouter || destinationCaller !== addressToBytes32(hookRouter)) {
      return { relay: false, reason: "foreign_destination_caller" };
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

export function decodeMessageHeader(messageHex: string): MessageHeader {
  const bytes = getBytes(messageHex);
  if (bytes.length < BODY_VERSION_OFFSET) {
    throw new Error(`message too short for CCTP V2 header: ${bytes.length} bytes`);
  }
  return {
    sourceDomain: uint32At(bytes, 4),
    destinationDomain: uint32At(bytes, 8),
    nonce: dataSlice(bytes, 12, 44).toLowerCase(),
  };
}
