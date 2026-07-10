// ABOUTME: v1 test vectors for classifyMessageForRelay, ported verbatim from
// ABOUTME: relayer/test/modules/classify-message-for-relay.test.ts (chai → vitest).
import { describe, it, expect } from "vitest";
import { zeroPadValue } from "ethers";
import {
  classifyMessageForRelay,
  decodeMessageHeader,
  addressToBytes32,
  MIN_MESSAGE_LENGTH_BYTES,
} from "../src/jobs/classify.js";
import { buildCctpMessage, ZERO32 } from "./helpers.js";

// MessageV2 envelope offsets (bytes): destinationCaller@108, body@148; BurnMessageV2 body:
// version@0 (abs 148), mintRecipient@36 (abs 184). Min total length 376 bytes.
const POOL = zeroPadValue("0x" + "11".repeat(20), 32).toLowerCase();
const HOOK_ROUTER = "0x" + "22".repeat(20);
const HOOK_ROUTER_BYTES32 = zeroPadValue(HOOK_ROUTER, 32).toLowerCase();

/** v1 vector builder: fields the classifier inspects; everything else zero-filled. */
function buildMessage(opts: {
  bodyVersion?: number;
  mintRecipient?: string; // bytes32 hex
  destinationCaller?: string; // bytes32 hex
  totalBytes?: number;
}): string {
  const total = opts.totalBytes ?? 376;
  const buf = Buffer.alloc(total);
  if (total >= 152) buf.writeUInt32BE(opts.bodyVersion ?? 1, 148); // body version (abs 148)
  if (opts.mintRecipient && total >= 216) {
    Buffer.from(opts.mintRecipient.replace(/^0x/, ""), "hex").copy(buf, 184);
  }
  if (opts.destinationCaller && total >= 140) {
    Buffer.from(opts.destinationCaller.replace(/^0x/, ""), "hex").copy(buf, 108);
  }
  return "0x" + buf.toString("hex");
}

const KNOWN = new Set([POOL]);

describe("classifyMessageForRelay (v1 vectors)", () => {
  it("relays a genuine BurnMessageV2 to a known recipient with zero destinationCaller", () => {
    const msg = buildMessage({ mintRecipient: POOL });
    const result = classifyMessageForRelay(msg, KNOWN, HOOK_ROUTER);
    expect(result.relay).toBe(true);
    if (result.relay) expect(result.mintRecipient).toBe(POOL);
  });

  it("rejects a too-short message (the gas-drain vector) instead of failing open", () => {
    const msg = buildMessage({ mintRecipient: POOL, totalBytes: 200 });
    const result = classifyMessageForRelay(msg, KNOWN, HOOK_ROUTER);
    expect(result.relay).toBe(false);
    if (!result.relay) expect(result.reason).toContain("minimum");
  });

  it("rejects a message whose body version is not the BurnMessageV2 version", () => {
    const msg = buildMessage({ mintRecipient: POOL, bodyVersion: 99 });
    const result = classifyMessageForRelay(msg, KNOWN, HOOK_ROUTER);
    expect(result.relay).toBe(false);
    if (!result.relay) expect(result.reason).toContain("version");
  });

  it("rejects a mintRecipient that is not in knownRecipients", () => {
    const stranger = zeroPadValue("0x" + "99".repeat(20), 32).toLowerCase();
    const msg = buildMessage({ mintRecipient: stranger });
    const result = classifyMessageForRelay(msg, KNOWN, HOOK_ROUTER);
    expect(result.relay).toBe(false);
    if (!result.relay) expect(result.reason).toContain("not in knownRecipients");
  });

  it("rejects everything when knownRecipients is empty (misconfiguration ⇒ fail closed)", () => {
    const msg = buildMessage({ mintRecipient: POOL });
    const result = classifyMessageForRelay(msg, new Set(), HOOK_ROUTER);
    expect(result.relay).toBe(false);
    if (!result.relay) expect(result.reason).toContain("no known recipients");
  });

  it("relays when destinationCaller is set and equals our hookRouter", () => {
    const msg = buildMessage({ mintRecipient: POOL, destinationCaller: HOOK_ROUTER_BYTES32 });
    const result = classifyMessageForRelay(msg, KNOWN, HOOK_ROUTER);
    expect(result.relay).toBe(true);
  });

  it("rejects when destinationCaller is set but does not equal our hookRouter", () => {
    const otherCaller = zeroPadValue("0x" + "ab".repeat(20), 32).toLowerCase();
    const msg = buildMessage({ mintRecipient: POOL, destinationCaller: otherCaller });
    const result = classifyMessageForRelay(msg, KNOWN, HOOK_ROUTER);
    expect(result.relay).toBe(false);
    if (!result.relay) expect(result.reason).toContain("hookRouter");
  });
});

describe("v2-preserved v1 nuances", () => {
  it("with NO hookRouter configured, a non-zero destinationCaller passes (v1 code wins)", () => {
    const otherCaller = zeroPadValue("0x" + "ab".repeat(20), 32).toLowerCase();
    const msg = buildMessage({ mintRecipient: POOL, destinationCaller: otherCaller });
    expect(classifyMessageForRelay(msg, KNOWN, null)).toMatchObject({ relay: true });
  });

  it("accepts exactly 376 bytes; helpers builder matches the v1 layout", () => {
    expect(MIN_MESSAGE_LENGTH_BYTES).toBe(376);
    const viaHelpers = buildCctpMessage(); // POOL_ADDRESS recipient fixture
    expect(classifyMessageForRelay(viaHelpers, new Set(), HOOK_ROUTER)).toMatchObject({
      relay: false,
    });
  });

  it("rejects unparseable hex", () => {
    expect(classifyMessageForRelay("0xzz", KNOWN, HOOK_ROUTER)).toEqual({
      relay: false,
      reason: "unparseable message hex",
    });
  });
});

describe("decodeMessageHeader", () => {
  it("extracts source/destination domains and nonce", () => {
    const nonce = "0x" + "ab".repeat(32);
    const msg = buildCctpMessage({ sourceDomain: 6, destinationDomain: 0, nonce });
    expect(decodeMessageHeader(msg)).toEqual({
      sourceDomain: 6,
      destinationDomain: 0,
      nonce,
    });
  });

  it("nonce is zero at source in CCTP V2 fixtures", () => {
    expect(decodeMessageHeader(buildCctpMessage()).nonce).toBe(ZERO32);
  });

  it("throws on messages shorter than the header", () => {
    expect(() => decodeMessageHeader("0x0000")).toThrow(/too short/);
  });

  it("addressToBytes32 lowercases and left-pads", () => {
    expect(addressToBytes32("0x" + "AB".repeat(20))).toBe("0x" + "00".repeat(12) + "ab".repeat(20));
  });
});
