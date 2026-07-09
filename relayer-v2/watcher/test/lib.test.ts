// ABOUTME: Watcher pure-logic tests (§15.1): CCTP header decode, config derivation from
// ABOUTME: manifests (loud failures), cursor/cache-control/health helpers for the read API.
import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeCctpHeader, logRowId, dedupKey, messageHashOf } from "../src/lib/decode";
import { resolveChains, protocolAddressAllowlist, networkName } from "../src/lib/manifests";
import {
  parseRangeParams,
  nextCursorOf,
  cacheControlFor,
  checkpointBlock,
  classifyFreshness,
  worstOf,
  MAX_LIMIT,
} from "../src/lib/api-helpers";

const DEPLOYMENTS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "deployments");

describe("decodeCctpHeader", () => {
  it("decodes domains and nonce from a V2 header", () => {
    const hex =
      "0x" +
      "00000001" + // version
      "00000065" + // sourceDomain 101
      "00000064" + // destinationDomain 100
      "ab".repeat(32); // nonce
    expect(decodeCctpHeader(hex)).toEqual({
      sourceDomain: 101,
      destinationDomain: 100,
      nonce: "0x" + "ab".repeat(32),
    });
  });

  it("throws on short messages", () => {
    expect(() => decodeCctpHeader("0x1234")).toThrow(/too short/);
  });

  it("id conventions: log rows chainId-prefixed, dedupKey preserved from v1", () => {
    expect(logRowId(31337, "0xabc", 3)).toBe("31337:0xabc:3");
    expect(dedupKey("0xabc", 3)).toBe("0xabc:3"); // §3 dedupKey
    expect(messageHashOf("0x1234")).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("config derivation from manifests (§7.2)", () => {
  it("resolves the local network with defaults", () => {
    const chains = resolveChains({ NETWORK: "local" } as NodeJS.ProcessEnv, DEPLOYMENTS);
    expect(chains.map((c) => c.chainId)).toEqual([31337, 31338, 31339]);
    expect(chains[0]!.rpcUrl).toBe("http://127.0.0.1:8545");
    expect(chains[0]!.manifest.contracts.privacyPool).toMatch(/^0x/);
  });

  it("missing manifests fail loudly (mainnet posture, §15.4)", () => {
    expect(() =>
      resolveChains(
        {
          NETWORK: "mainnet",
          RPC_URL_1: "https://rpc",
          RPC_URL_8453: "https://rpc",
          RPC_URL_42161: "https://rpc",
        } as NodeJS.ProcessEnv,
        DEPLOYMENTS,
      ),
    ).toThrow(/Missing deployment manifest for NETWORK=mainnet chainId=1/);
  });

  it("missing RPC URLs fail loudly on non-local networks", () => {
    expect(() =>
      resolveChains({ NETWORK: "sepolia" } as NodeJS.ProcessEnv, DEPLOYMENTS),
    ).toThrow(/RPC_URL_11155111/);
  });

  it("rejects unknown NETWORK values", () => {
    expect(() => networkName({ NETWORK: "goerli" } as NodeJS.ProcessEnv)).toThrow(
      /local\|sepolia\|mainnet/,
    );
  });

  it("builds the per-chain protocol address allowlist for /v1/logs (P1)", () => {
    const chains = resolveChains({ NETWORK: "local" } as NodeJS.ProcessEnv, DEPLOYMENTS);
    const allowlist = protocolAddressAllowlist(chains);
    expect(allowlist.get(31337)!.has("0x5fbdb2315678afecb367f032d93f642f64180aa3")).toBe(true);
    expect(allowlist.get(31337)!.has("0x" + "99".repeat(20))).toBe(false);
  });
});

describe("api helpers (§7.3)", () => {
  it("parses range params with limit clamped to 1000", () => {
    expect(parseRangeParams({ fromBlock: "5", toBlock: "9", limit: "10" })).toEqual({
      fromBlock: 5n,
      toBlock: 9n,
      limit: 10,
    });
    expect(parseRangeParams({ fromBlock: "5", limit: "5000" })).toMatchObject({
      limit: MAX_LIMIT,
    });
    expect(parseRangeParams({})).toHaveProperty("error");
    expect(parseRangeParams({ fromBlock: "-1" })).toHaveProperty("error");
  });

  it("nextCursor is block-based and null when the page is not full", () => {
    expect(nextCursorOf([{ blockNumber: 7n }, { blockNumber: 9n }], 2)).toBe("10");
    expect(nextCursorOf([{ blockNumber: 7n }], 2)).toBeNull();
    expect(nextCursorOf([], 2)).toBeNull();
  });

  it("cache-control: immutable for confirmed closed ranges, 5s otherwise", () => {
    expect(cacheControlFor(90n, 100n, 6)).toBe("public, max-age=86400, immutable");
    expect(cacheControlFor(95n, 100n, 6)).toBe("public, max-age=5");
    expect(cacheControlFor(null, 100n, 6)).toBe("public, max-age=5");
    expect(cacheControlFor(90n, null, 6)).toBe("public, max-age=5");
  });

  it("decodes ponder checkpoint strings", () => {
    const checkpoint =
      "1750000000" + "0000000000031337" + "0000000000000042" + "0000000000000000" + "5" + "0000000000000000";
    expect(checkpointBlock(checkpoint)).toEqual({ timestamp: 1_750_000_000n, number: 42n });
    expect(checkpointBlock("nope")).toBeNull();
  });

  it("freshness classification mirrors §6.6", () => {
    const now = 1_000_000;
    expect(classifyFreshness(now, null, 1000, null)).toBe("unhealthy");
    expect(classifyFreshness(now, now - 20_000, 1000, 0)).toBe("unhealthy");
    expect(classifyFreshness(now, now - 5_000, 1000, 0)).toBe("stale");
    expect(classifyFreshness(now, now - 500, 1000, 500)).toBe("degraded");
    expect(classifyFreshness(now, now - 500, 1000, 1)).toBe("healthy");
    expect(worstOf(["healthy", "stale", "degraded"])).toBe("stale");
  });
});
