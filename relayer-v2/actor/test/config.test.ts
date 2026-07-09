// ABOUTME: Config derivation tests (§7.2, §15.4): all three networks build and validate,
// ABOUTME: domain pairing asserted, missing manifests fail loudly and specifically.
import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getTopology, assertDomainPairing, allChains } from "../src/config/networks.js";
import { loadAllManifests, loadManifest } from "../src/config/manifests.js";
import { buildConfig } from "../src/config/env.js";

const DEPLOYMENTS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "deployments");

const BASE_ENV = {
  NETWORK: "local",
  DATABASE_URL: "postgres://x",
  ETH_USD_PRICE_STATIC: "3000",
};

describe("network topology (§7.2 table)", () => {
  it("local: hub 31337 domain 100, clients 31338/101 and 31339/102, mock iris", () => {
    const t = getTopology("local");
    expect(t.hub).toMatchObject({ chainId: 31337, domain: 100 });
    expect(t.clients.map((c) => [c.chainId, c.domain])).toEqual([
      [31338, 101],
      [31339, 102],
    ]);
    expect(t.irisMode).toBe("mock");
  });

  it("sepolia: 11155111/0, 84532/6, 421614/3, sandbox iris", () => {
    const t = getTopology("sepolia");
    expect(t.hub).toMatchObject({ chainId: 11155111, domain: 0 });
    expect(t.clients.map((c) => [c.chainId, c.domain])).toEqual([
      [84532, 6],
      [421614, 3],
    ]);
    expect(t.irisBaseUrl).toBe("https://iris-api-sandbox.circle.com");
  });

  it("mainnet: 1/0, 8453/6, 42161/3, prod iris — config posture builds (§15.4)", () => {
    const t = getTopology("mainnet");
    expect(t.hub).toMatchObject({ chainId: 1, domain: 0 });
    expect(t.clients.map((c) => [c.chainId, c.domain])).toEqual([
      [8453, 6],
      [42161, 3],
    ]);
    expect(t.irisBaseUrl).toBe("https://iris-api.circle.com");
    expect(() => assertDomainPairing(t)).not.toThrow();
  });

  it("all three networks pass domain-pairing validation", () => {
    for (const network of ["local", "sepolia", "mainnet"] as const) {
      expect(() => assertDomainPairing(getTopology(network))).not.toThrow();
    }
  });

  it("rejects unknown network names", () => {
    expect(() => getTopology("goerli")).toThrow(/local\|sepolia\|mainnet/);
  });

  it("poll intervals per §7.2: local 1s; sepolia hub 12s, L2s 5s", () => {
    expect(getTopology("local").hub.pollingIntervalMs).toBe(1000);
    const sepolia = getTopology("sepolia");
    expect(sepolia.hub.pollingIntervalMs).toBe(12000);
    expect(sepolia.clients.every((c) => c.pollingIntervalMs === 5000)).toBe(true);
  });

  it("confirmation depths: L1 6, L2 2, local 0 (§7.2)", () => {
    expect(allChains(getTopology("local")).every((c) => c.confirmations === 0)).toBe(true);
    const sepolia = getTopology("sepolia");
    expect(sepolia.hub.confirmations).toBe(6);
    expect(sepolia.clients.every((c) => c.confirmations === 2)).toBe(true);
  });
});

describe("manifest loading (§7.2)", () => {
  it("loads all local manifests", () => {
    const all = loadAllManifests(DEPLOYMENTS, getTopology("local"));
    expect(all).toHaveLength(3);
    expect(all[0]!.manifest.contracts.privacyPool).toMatch(/^0x/);
  });

  it("missing manifest fails loudly and specifically (mainnet posture)", () => {
    const t = getTopology("mainnet");
    expect(() => loadManifest(DEPLOYMENTS, "mainnet", t.hub)).toThrow(
      /Missing deployment manifest for NETWORK=mainnet chainId=1.*hub\.json/s,
    );
  });

  it("rejects manifests whose chainId/domain disagree with the topology", () => {
    const t = getTopology("local");
    const wrongChain = { ...t.hub, chainId: 31338, domain: 100, role: "hub" as const };
    expect(() => loadManifest(DEPLOYMENTS, "local", wrongChain)).toThrow(/chainId/);
  });
});

describe("buildConfig", () => {
  it("builds a full local config with defaults", () => {
    const config = buildConfig(BASE_ENV as NodeJS.ProcessEnv, DEPLOYMENTS);
    expect(config.network).toBe("local");
    expect(config.rpcUrls.get(31337)).toBe("http://127.0.0.1:8545");
    expect(config.feeTtlSeconds).toBe(300);
    expect(config.feeVarianceBufferBps).toBe(2000);
    expect(config.stuckTxThresholdMs).toBe(600_000);
    expect(config.maxAttestationAgeMs).toBe(3_600_000);
    expect(config.fallbackActivateAfterMs).toBe(120_000);
    expect(config.relayRatePerMin).toBe(10);
    expect(config.getRatePerMin).toBe(60);
    expect(config.bodyLimitBytes).toBe(256 * 1024);
  });

  it("requires DATABASE_URL and ETH_USD_PRICE_STATIC", () => {
    expect(() =>
      buildConfig({ NETWORK: "local", ETH_USD_PRICE_STATIC: "3000" } as NodeJS.ProcessEnv, DEPLOYMENTS),
    ).toThrow(/DATABASE_URL/);
    expect(() =>
      buildConfig({ NETWORK: "local", DATABASE_URL: "postgres://x" } as NodeJS.ProcessEnv, DEPLOYMENTS),
    ).toThrow(/ETH_USD_PRICE_STATIC/);
  });

  it("non-local networks require ETH_USD_FEED_ADDRESS (§8.8)", () => {
    expect(() =>
      buildConfig(
        {
          NETWORK: "sepolia",
          DATABASE_URL: "postgres://x",
          ETH_USD_PRICE_STATIC: "3000",
          RPC_URL_11155111: "https://rpc",
          RPC_URL_84532: "https://rpc",
          RPC_URL_421614: "https://rpc",
        } as NodeJS.ProcessEnv,
        DEPLOYMENTS,
      ),
    ).toThrow(/ETH_USD_FEED_ADDRESS/);
  });

  it("env-overridable thresholds enforce their minimums (§6.4)", () => {
    expect(() =>
      buildConfig(
        { ...BASE_ENV, STUCK_TX_THRESHOLD_MS: "30000" } as NodeJS.ProcessEnv,
        DEPLOYMENTS,
      ),
    ).toThrow(/STUCK_TX_THRESHOLD_MS/);
    expect(() =>
      buildConfig(
        { ...BASE_ENV, MAX_ATTESTATION_AGE_MS: "1000" } as NodeJS.ProcessEnv,
        DEPLOYMENTS,
      ),
    ).toThrow(/MAX_ATTESTATION_AGE_MS/);
  });

  it("missing RPC URL on non-default chains fails loudly", () => {
    expect(() =>
      buildConfig(
        {
          NETWORK: "sepolia",
          DATABASE_URL: "postgres://x",
          ETH_USD_PRICE_STATIC: "3000",
          ETH_USD_FEED_ADDRESS: "0x" + "11".repeat(20),
        } as NodeJS.ProcessEnv,
        DEPLOYMENTS,
      ),
    ).toThrow(/RPC_URL_11155111|Missing deployment manifest/);
  });
});
