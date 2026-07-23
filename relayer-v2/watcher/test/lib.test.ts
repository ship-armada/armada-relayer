// ABOUTME: Watcher pure-logic tests (§15.1): CCTP header decode, config derivation from
// ABOUTME: manifests (loud failures), cursor/cache-control/health helpers for the read API.
import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeCctpHeader, logRowId, dedupKey, messageHashOf } from "../src/lib/decode";
import {
  resolveChains,
  protocolAddressAllowlist,
  networkName,
  resolveSource,
  cctpStartBlock,
  hookRouterAddress,
} from "../src/lib/manifests";
import {
  parseRangeParams,
  nextCursorOf,
  cacheControlFor,
  checkpointBlock,
  classifyFreshness,
  worstOf,
  MAX_LIMIT,
} from "../src/lib/api-helpers";

// Flat fixture manifests (local mode / monorepo e2e path — not committed at repo root).
const DEPLOYMENTS = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "deployments");
// Repo deployments root; its `registry/` submodule holds the real published manifests.
const REPO_DEPLOYMENTS = join(
  dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "deployments",
);

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

describe("resolveSource (manifest source selection)", () => {
  it("no DEPLOYMENT_INSTANCE ⇒ flat provider", () => {
    expect(resolveSource({ NETWORK: "local" } as NodeJS.ProcessEnv, "/d")).toEqual({
      kind: "flat",
      root: "/d",
    });
  });

  it("treats compose-passed EMPTY STRINGS as unset (${VAR:-} → '')", () => {
    // Regression for the watcher's sepolia boot crash "no registry environment maps to
    // NETWORK=sepolia" — compose passes unset vars as "", which `??` would not catch.
    const s = resolveSource(
      {
        NETWORK: "sepolia",
        DEPLOYMENT_INSTANCE: "demo1",
        DEPLOYMENT_ENVIRONMENT: "",
        DEPLOYMENT_REGISTRY_DIR: "",
      } as NodeJS.ProcessEnv,
      "/d",
    );
    expect(s).toEqual({ kind: "registry", root: "/d/registry", environment: "testnet", instance: "demo1" });
    expect(resolveSource({ NETWORK: "sepolia", DEPLOYMENT_INSTANCE: "" } as NodeJS.ProcessEnv, "/d")).toEqual({
      kind: "flat",
      root: "/d",
    });
  });
});

describe("config derivation from manifests (§7.2)", () => {
  it("resolves the local network with defaults", () => {
    const chains = resolveChains({ NETWORK: "local" } as NodeJS.ProcessEnv, DEPLOYMENTS);
    expect(chains.map((c) => c.chainId)).toEqual([31337, 31338, 31339]);
    expect(chains[0]!.rpcUrls).toEqual(["http://127.0.0.1:8545"]);
    expect(chains[0]!.manifest.contracts.privacyPool).toMatch(/^0x/);
  });

  it("splits comma-separated RPC env vars into a provider list (trimmed)", () => {
    // Ponder load-balances across all URLs in the list; a single URL stays a 1-element list.
    const chains = resolveChains(
      {
        NETWORK: "local",
        HUB_RPC: "https://rpc-a.example, https://rpc-b.example ,wss://rpc-c.example",
        CLIENT_A_RPC: "https://rpc-d.example",
      } as NodeJS.ProcessEnv,
      DEPLOYMENTS,
    );
    expect(chains[0]!.rpcUrls).toEqual([
      "https://rpc-a.example",
      "https://rpc-b.example",
      "wss://rpc-c.example",
    ]);
    expect(chains[1]!.rpcUrls).toEqual(["https://rpc-d.example"]);
    expect(chains[2]!.rpcUrls).toEqual(["http://127.0.0.1:8547"]); // default untouched
  });

  it("rejects RPC env vars that are only commas/whitespace", () => {
    expect(() =>
      resolveChains(
        { NETWORK: "local", HUB_RPC: " , " } as NodeJS.ProcessEnv,
        DEPLOYMENTS,
      ),
    ).toThrow(/Missing RPC URL.*HUB_RPC/);
  });

  it("resolves sepolia from the central registry (DEPLOYMENT_INSTANCE=demo1)", () => {
    const chains = resolveChains(
      {
        NETWORK: "sepolia",
        DEPLOYMENT_INSTANCE: "demo1",
        HUB_RPC: "https://rpc",
        CLIENT_A_RPC: "https://rpc",
        CLIENT_B_RPC: "https://rpc",
      } as NodeJS.ProcessEnv,
      REPO_DEPLOYMENTS,
    );
    expect(chains.map((c) => [c.chainId, c.domain])).toEqual([
      [11155111, 0],
      [84532, 6],
      [421614, 3],
    ]);
    expect(chains[0]!.manifest.contracts.privacyPool).toBe(
      "0x014aC1dfC2Bde83d4be2CFFb5bea4dE942DAD77F",
    );
    expect(chains[0]!.manifest.deployBlock).toBe(10893598);
  });

  it("missing registry instance fails loudly (mainnet posture, §15.4)", () => {
    expect(() =>
      resolveChains(
        {
          NETWORK: "mainnet",
          DEPLOYMENT_INSTANCE: "does-not-exist",
          HUB_RPC: "https://rpc",
          CLIENT_A_RPC: "https://rpc",
          CLIENT_B_RPC: "https://rpc",
        } as NodeJS.ProcessEnv,
        REPO_DEPLOYMENTS,
      ),
    ).toThrow(/Missing deployment registry instance/);
  });

  it("missing flat manifests also fail loudly (local/e2e path)", () => {
    expect(() =>
      resolveChains(
        {
          NETWORK: "mainnet",
          HUB_RPC: "https://rpc",
          CLIENT_A_RPC: "https://rpc",
          CLIENT_B_RPC: "https://rpc",
        } as NodeJS.ProcessEnv,
        DEPLOYMENTS,
      ),
    ).toThrow(/Missing deployment manifest for NETWORK=mainnet chainId=1/);
  });

  it("missing RPC URLs fail loudly on non-local networks", () => {
    expect(() =>
      resolveChains({ NETWORK: "sepolia" } as NodeJS.ProcessEnv, DEPLOYMENTS),
    ).toThrow(/HUB_RPC/);
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

describe("cctpStartBlock (forward-only CCTP indexing)", () => {
  const localChains = () =>
    resolveChains({ NETWORK: "local" } as NodeJS.ProcessEnv, DEPLOYMENTS);

  it("defaults to \"latest\" when neither env nor manifest pins a block", () => {
    const chain = localChains()[0]!; // fixtures carry no cctp.startBlock
    expect(cctpStartBlock({} as NodeJS.ProcessEnv, chain)).toBe("latest");
  });

  it("reads an absolute block from CCTP_START_BLOCK_<chainId>", () => {
    const chain = localChains()[0]!;
    expect(
      cctpStartBlock({ CCTP_START_BLOCK_31337: "8000000" } as unknown as NodeJS.ProcessEnv, chain),
    ).toBe(8000000);
  });

  it("accepts the literal \"latest\" override", () => {
    const chain = localChains()[0]!;
    expect(
      cctpStartBlock({ CCTP_START_BLOCK_31337: "latest" } as unknown as NodeJS.ProcessEnv, chain),
    ).toBe("latest");
  });

  it("treats an empty-string env var as unset (compose ${VAR:-} convention)", () => {
    const chain = localChains()[0]!;
    expect(
      cctpStartBlock({ CCTP_START_BLOCK_31337: "" } as unknown as NodeJS.ProcessEnv, chain),
    ).toBe("latest");
  });

  it("rejects a non-integer / negative override loudly", () => {
    const chain = localChains()[0]!;
    expect(() =>
      cctpStartBlock({ CCTP_START_BLOCK_31337: "-1" } as unknown as NodeJS.ProcessEnv, chain),
    ).toThrow(/CCTP_START_BLOCK_31337/);
    expect(() =>
      cctpStartBlock({ CCTP_START_BLOCK_31337: "1.5" } as unknown as NodeJS.ProcessEnv, chain),
    ).toThrow(/CCTP_START_BLOCK_31337/);
  });

  it("honors a manifest cctp.startBlock between the env override and the default", () => {
    const chain = localChains()[0]!;
    const pinned = { ...chain, manifest: { ...chain.manifest, cctp: { ...chain.manifest.cctp, startBlock: 12345 } } };
    expect(cctpStartBlock({} as NodeJS.ProcessEnv, pinned)).toBe(12345);
    // env override still wins over the manifest field
    expect(
      cctpStartBlock({ CCTP_START_BLOCK_31337: "999" } as unknown as NodeJS.ProcessEnv, pinned),
    ).toBe(999);
  });
});

describe("hookRouterAddress (MessageReceived caller filter source)", () => {
  it("returns the lowercased hookRouter when the manifest has one", () => {
    const chain = resolveChains({ NETWORK: "local" } as NodeJS.ProcessEnv, DEPLOYMENTS)[0]!;
    expect(hookRouterAddress(chain)).toBe("0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0");
  });

  it("returns null when the manifest carries no hookRouter (unfiltered fallback)", () => {
    const chain = resolveChains({ NETWORK: "local" } as NodeJS.ProcessEnv, DEPLOYMENTS)[0]!;
    const { hookRouter, ...rest } = chain.manifest.contracts;
    void hookRouter;
    const noRouter = { ...chain, manifest: { ...chain.manifest, contracts: rest } };
    expect(hookRouterAddress(noRouter)).toBeNull();
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
