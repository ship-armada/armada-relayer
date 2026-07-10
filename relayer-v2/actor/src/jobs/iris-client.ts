// ABOUTME: Circle Iris attestation client ported from v1 iris-relay.ts IrisApiClient: lookup by
// ABOUTME: /v2/messages/{sourceDomain}?transactionHash=, message matching, plausibility checks.

export const MIN_ATTESTATION_BYTES = 65;
export const MIN_BURN_MESSAGE_BYTES = 376;
const MSG_NONCE_OFFSET = 12;
const MSG_NONCE_LENGTH = 32; // bytes32 in real CCTP V2 (NOT 8-byte uint64)
const MSG_FINALITY_EXECUTED_OFFSET = 144;
const MSG_FINALITY_EXECUTED_LENGTH = 4;
export const DEFAULT_IRIS_FETCH_TIMEOUT_MS = 10_000;

/** Mock-mode attestation: empty bytes — the mock MessageTransmitter skips verification (v1). */
export const MOCK_ATTESTATION = "0x";

export type AttestationResult =
  | { status: "complete"; attestation: string; message: string }
  | { status: "pending"; detail?: string }
  | { status: "error"; detail: string };

export interface AttestationQuery {
  sourceDomain: number;
  sourceTxHash: string;
  /** Locally-observed MessageSent bytes — the Iris response must match these (modulo the
   * nonce/finality slots Iris legitimately fills) before we trust it. */
  expectedMessageHex: string;
}

export interface AttestationClient {
  fetch(query: AttestationQuery): Promise<AttestationResult>;
}

export function isPlausibleHexBytes(s: unknown, minBytes: number): boolean {
  if (typeof s !== "string" || !s.startsWith("0x")) return false;
  const body = s.slice(2);
  if (body.length % 2 !== 0) return false;
  if (!/^[0-9a-fA-F]*$/.test(body)) return false;
  return body.length / 2 >= minBytes;
}

function zeroHexRange(hex: string, startByte: number, lenBytes: number): string {
  return (
    hex.slice(0, startByte * 2) + "0".repeat(lenBytes * 2) + hex.slice((startByte + lenBytes) * 2)
  );
}

/** True when two MessageV2 byte strings are identical outside the nonce and
 * finalityThresholdExecuted slots (which Iris fills in). Ported verbatim from v1. */
export function irisMessageMatches(localHex: string, irisHex: string): boolean {
  const a = (localHex.startsWith("0x") ? localHex.slice(2) : localHex).toLowerCase();
  const b = (irisHex.startsWith("0x") ? irisHex.slice(2) : irisHex).toLowerCase();
  if (a.length !== b.length) return false;
  const na = zeroHexRange(
    zeroHexRange(a, MSG_NONCE_OFFSET, MSG_NONCE_LENGTH),
    MSG_FINALITY_EXECUTED_OFFSET,
    MSG_FINALITY_EXECUTED_LENGTH,
  );
  const nb = zeroHexRange(
    zeroHexRange(b, MSG_NONCE_OFFSET, MSG_NONCE_LENGTH),
    MSG_FINALITY_EXECUTED_OFFSET,
    MSG_FINALITY_EXECUTED_LENGTH,
  );
  return na === nb;
}

export class MockAttestationClient implements AttestationClient {
  async fetch(query: AttestationQuery): Promise<AttestationResult> {
    return { status: "complete", attestation: MOCK_ATTESTATION, message: query.expectedMessageHex };
  }
}

interface IrisMessageEntry {
  attestation?: string;
  message?: string;
  eventNonce?: string;
  status?: string;
}

export class IrisClient implements AttestationClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs: number = DEFAULT_IRIS_FETCH_TIMEOUT_MS,
  ) {}

  async fetch(query: AttestationQuery): Promise<AttestationResult> {
    const url = `${this.baseUrl}/v2/messages/${query.sourceDomain}?transactionHash=${query.sourceTxHash}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url, { signal: controller.signal });
      } catch (err) {
        const reason =
          (err as Error)?.name === "AbortError"
            ? `timeout after ${this.timeoutMs}ms`
            : ((err as Error)?.message ?? String(err));
        return { status: "error", detail: `network: ${reason}` };
      }
      if (response.status === 404) return { status: "pending", detail: "not yet indexed" };
      if (!response.ok) return { status: "error", detail: `http ${response.status}` };

      let data: { messages?: IrisMessageEntry[] };
      try {
        data = (await response.json()) as typeof data;
      } catch {
        return { status: "error", detail: "unparseable body" };
      }
      if (!data.messages || data.messages.length === 0) {
        return { status: "pending", detail: "no messages" };
      }

      // Select the entry that corresponds to OUR message (a source tx can emit multiple
      // MessageSent); fall back to [0] only when there's exactly one entry (v1 behavior).
      let msg: IrisMessageEntry | undefined;
      if (data.messages.length === 1) {
        msg = data.messages[0];
      } else {
        msg = data.messages.find(
          (m) =>
            typeof m.message === "string" &&
            irisMessageMatches(query.expectedMessageHex, m.message),
        );
      }
      if (!msg) return { status: "error", detail: "no matching message in Iris response" };

      if (msg.status === "complete" && msg.attestation) {
        // Validate what we're about to broadcast is well-formed hex of plausible size.
        if (!isPlausibleHexBytes(msg.attestation, MIN_ATTESTATION_BYTES)) {
          return { status: "error", detail: "implausible attestation bytes" };
        }
        if (!isPlausibleHexBytes(msg.message, MIN_BURN_MESSAGE_BYTES)) {
          return { status: "error", detail: "implausible message bytes" };
        }
        // Trust the Iris message ONLY if it matches the locally-observed bytes outside the
        // nonce/finality slots — otherwise refuse (v1 submitRelay guard).
        if (!irisMessageMatches(query.expectedMessageHex, msg.message!)) {
          return { status: "error", detail: "Iris message does not match observed bytes" };
        }
        return { status: "complete", attestation: msg.attestation, message: msg.message! };
      }
      return { status: "pending", detail: msg.status ?? "unknown" };
    } finally {
      clearTimeout(timer);
    }
  }
}
