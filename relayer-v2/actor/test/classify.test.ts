// ABOUTME: Test vectors for the fail-closed message classifier (§8.5): length, body version,
// ABOUTME: mint-recipient set membership, destinationCaller, empty-set rejection.
import { describe, it, expect } from "vitest";
import { zeroPadValue } from "ethers";
import {
  classifyMessageForRelay,
  decodeMessageHeader,
  addressToBytes32,
  MIN_MESSAGE_LENGTH_BYTES,
} from "../src/jobs/classify.js";
import { buildCctpMessage, POOL_ADDRESS, HOOK_ROUTER, ZERO32 } from "./helpers.js";

const RECIPIENTS = new Set([addressToBytes32(POOL_ADDRESS)]);

describe("classifyMessageForRelay (§8.5)", () => {
  it("relays a well-formed message to a known recipient with zero destinationCaller", () => {
    const result = classifyMessageForRelay(buildCctpMessage(), RECIPIENTS, HOOK_ROUTER);
    expect(result).toEqual({ relay: true, mintRecipient: addressToBytes32(POOL_ADDRESS) });
  });

  it("relays when destinationCaller equals the configured HookRouter", () => {
    const msg = buildCctpMessage({ destinationCaller: addressToBytes32(HOOK_ROUTER) });
    expect(classifyMessageForRelay(msg, RECIPIENTS, HOOK_ROUTER)).toMatchObject({ relay: true });
  });

  it("rejects messages shorter than 376 bytes", () => {
    const msg = buildCctpMessage({ truncate: MIN_MESSAGE_LENGTH_BYTES - 1 });
    expect(classifyMessageForRelay(msg, RECIPIENTS, HOOK_ROUTER)).toEqual({
      relay: false,
      reason: `too_short:${MIN_MESSAGE_LENGTH_BYTES - 1}`,
    });
  });

  it("accepts messages exactly 376 bytes and longer", () => {
    expect(classifyMessageForRelay(buildCctpMessage(), RECIPIENTS, HOOK_ROUTER)).toMatchObject({
      relay: true,
    });
    const longer = buildCctpMessage() + "ff".repeat(32);
    expect(classifyMessageForRelay(longer, RECIPIENTS, HOOK_ROUTER)).toMatchObject({
      relay: true,
    });
  });

  it("rejects burn body version != 1", () => {
    const msg = buildCctpMessage({ bodyVersion: 0 });
    expect(classifyMessageForRelay(msg, RECIPIENTS, HOOK_ROUTER)).toEqual({
      relay: false,
      reason: "body_version:0",
    });
    const msg2 = buildCctpMessage({ bodyVersion: 2 });
    expect(classifyMessageForRelay(msg2, RECIPIENTS, HOOK_ROUTER)).toEqual({
      relay: false,
      reason: "body_version:2",
    });
  });

  it("rejects unknown mint recipients", () => {
    const msg = buildCctpMessage({
      mintRecipient: zeroPadValue("0x" + "99".repeat(20), 32),
    });
    expect(classifyMessageForRelay(msg, RECIPIENTS, HOOK_ROUTER)).toEqual({
      relay: false,
      reason: "unknown_mint_recipient",
    });
  });

  it("empty known-recipient set relays nothing (fail closed)", () => {
    expect(classifyMessageForRelay(buildCctpMessage(), new Set(), HOOK_ROUTER)).toEqual({
      relay: false,
      reason: "no_known_recipients",
    });
  });

  it("rejects a foreign destinationCaller", () => {
    const msg = buildCctpMessage({
      destinationCaller: addressToBytes32("0x" + "77".repeat(20)),
    });
    expect(classifyMessageForRelay(msg, RECIPIENTS, HOOK_ROUTER)).toEqual({
      relay: false,
      reason: "foreign_destination_caller",
    });
  });

  it("rejects a nonzero destinationCaller when no HookRouter is configured", () => {
    const msg = buildCctpMessage({ destinationCaller: addressToBytes32(HOOK_ROUTER) });
    expect(classifyMessageForRelay(msg, RECIPIENTS, null)).toEqual({
      relay: false,
      reason: "foreign_destination_caller",
    });
  });

  it("rejects unparseable hex", () => {
    expect(classifyMessageForRelay("0xzz", RECIPIENTS, HOOK_ROUTER)).toEqual({
      relay: false,
      reason: "unparseable_message",
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
});
