// ABOUTME: Circle Iris attestation client (§8.4): messageHash-keyed lookups against the
// ABOUTME: sandbox/prod API, plus the mock-mode client that attests immediately (local dev).

export type AttestationResult =
  | { status: "complete"; attestation: string }
  | { status: "pending" }
  | { status: "error"; detail: string };

export interface AttestationClient {
  fetch(messageHash: string): Promise<AttestationResult>;
}

/** Mock attestation bytes used in CCTP_MODE=mock (local): fixed 65-byte blob (§8.4). */
export const MOCK_ATTESTATION = "0x" + "00".repeat(65);

export class MockAttestationClient implements AttestationClient {
  async fetch(): Promise<AttestationResult> {
    return { status: "complete", attestation: MOCK_ATTESTATION };
  }
}

export class IrisClient implements AttestationClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async fetch(messageHash: string): Promise<AttestationResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/attestations/${messageHash}`, {
        headers: { accept: "application/json" },
      });
    } catch (err) {
      return { status: "error", detail: `network: ${(err as Error).message}` };
    }
    if (res.status === 404) return { status: "pending" }; // not yet known to Iris
    if (!res.ok) return { status: "error", detail: `http ${res.status}` };
    let body: { status?: string; attestation?: string };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      return { status: "error", detail: "unparseable body" };
    }
    if (body.status === "complete" && typeof body.attestation === "string") {
      return { status: "complete", attestation: body.attestation };
    }
    return { status: "pending" };
  }
}
