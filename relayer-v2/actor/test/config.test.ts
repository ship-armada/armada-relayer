// ABOUTME: Config derivation tests (§7.2, §15.4): three networks build/validate, real manifest
// ABOUTME: schema loads, missing manifests fail loudly, v1 env names honored, CCTP_MODE rules.
import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getTopology, assertDomainPairing, allChains } from "../src/config/networks.js";
import {
  loadAllManifests,
  loadYieldManifest,
  networkSuffix,
  gaslessWrapperAddress,
  type DeploymentSource,
} from "../src/config/manifests.js";
import { buildConfig, resolveDeploymentSource } from "../src/config/env.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// Flat fixture manifests in the real schema (local mode / monorepo e2e path).
const FIXTURES = join(HERE, "fixtures", "deployments");
// The central registry submodule — the real published manifests (testnet/demo1).
const REGISTRY_ROOT = join(HERE, "..", "..", "..", "deployments", "registry");

const flat = (root: string): DeploymentSource => ({ kind: "flat", root });
const demo1 = (): DeploymentSource => ({
  kind: "registry",
  root: REGISTRY_ROOT,
  environment: "testnet",
  instance: "demo1",
});

const BASE_ENV = {
  NETWORK: "local",
  DATABASE_URL: "postgres://x",
  ETH_USD_PRICE_STATIC: "3000",
};

describe("network topology (§7.2 table)", () => {
  it("local: hub 31337 domain 100, clients 31338/101 and 31339/102, mock mode", () => {
    const t = getTopology("local");
    expect(t.hub).toMatchObject({ chainId: 31337, domain: 100, manifestPrefix: "hub" });
    expect(t.clients.map((c) => [c.chainId, c.domain, c.manifestPrefix])).toEqual([
      [31338, 101, "client"],
      [31339, 102, "clientB"],
    ]);
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

  it("poll intervals and confirmation depths per §7.2", () => {
    expect(getTopology("local").hub.pollingIntervalMs).toBe(1000);
    const sepolia = getTopology("sepolia");
    expect(sepolia.hub.pollingIntervalMs).toBe(12000);
    expect(sepolia.clients.every((c) => c.pollingIntervalMs === 5000)).toBe(true);
    expect(allChains(getTopology("local")).every((c) => c.confirmations === 0)).toBe(true);
    expect(sepolia.hub.confirmations).toBe(6);
    expect(sepolia.clients.every((c) => c.confirmations === 2)).toBe(true);
  });
});

describe("manifest source selection (resolveDeploymentSource)", () => {
  it("no DEPLOYMENT_INSTANCE ⇒ flat provider at DEPLOYMENTS_DIR", () => {
    expect(resolveDeploymentSource({}, "local", "/d")).toEqual({ kind: "flat", root: "/d" });
  });

  it("DEPLOYMENT_INSTANCE ⇒ registry; environment derives from network (sepolia→testnet)", () => {
    expect(resolveDeploymentSource({ DEPLOYMENT_INSTANCE: "demo1" }, "sepolia", "/d")).toEqual({
      kind: "registry",
      root: "/d/registry",
      environment: "testnet",
      instance: "demo1",
    });
    const mainnetSrc = resolveDeploymentSource({ DEPLOYMENT_INSTANCE: "m1" }, "mainnet", "/d");
    expect(mainnetSrc).toMatchObject({ kind: "registry", environment: "mainnet" });
  });

  it("DEPLOYMENT_REGISTRY_DIR overrides the registry root", () => {
    const s = resolveDeploymentSource(
      { DEPLOYMENT_INSTANCE: "demo1", DEPLOYMENT_REGISTRY_DIR: "/reg" },
      "sepolia",
      "/d",
    );
    expect(s).toMatchObject({ kind: "registry", root: "/reg" });
  });

  it("treats compose-passed EMPTY STRINGS as unset (${VAR:-} → '')", () => {
    // Compose passes unset vars as "", which `??` would NOT catch — regression for the
    // sepolia boot failure "no registry environment maps to NETWORK=sepolia".
    const s = resolveDeploymentSource(
      { DEPLOYMENT_INSTANCE: "demo1", DEPLOYMENT_ENVIRONMENT: "", DEPLOYMENT_REGISTRY_DIR: "" },
      "sepolia",
      "/d",
    );
    expect(s).toEqual({ kind: "registry", root: "/d/registry", environment: "testnet", instance: "demo1" });
    // empty DEPLOYMENT_INSTANCE ⇒ flat (not a broken registry source)
    expect(resolveDeploymentSource({ DEPLOYMENT_INSTANCE: "" }, "sepolia", "/d")).toEqual({
      kind: "flat",
      root: "/d",
    });
  });
});

describe("flat provider (local / monorepo e2e)", () => {
  it("loads the fixture local manifests (hub pool + client pools + cctp block)", () => {
    const all = loadAllManifests(flat(FIXTURES), getTopology("local"));
    expect(all).toHaveLength(3);
    expect(all[0]!.manifest.contracts.privacyPool).toMatch(/^0x/);
    expect(all[1]!.manifest.contracts.privacyPoolClient).toMatch(/^0x/);
    expect(all[0]!.manifest.cctp.messageTransmitter).toMatch(/^0x/);
    expect(gaslessWrapperAddress(all[0]!)).toMatch(/^0x/);
    expect(loadYieldManifest(flat(FIXTURES), getTopology("local"))!.contracts.armadaYieldAdapter)
      .toMatch(/^0x/);
  });

  it("suffix convention: '' local, '-sepolia', '-mainnet'", () => {
    expect(networkSuffix("local")).toBe("");
    expect(networkSuffix("sepolia")).toBe("-sepolia");
    expect(networkSuffix("mainnet")).toBe("-mainnet");
  });

  it("missing flat manifest fails loudly", () => {
    expect(() => loadAllManifests(flat("/no/such/dir"), getTopology("local"))).toThrow(
      /Missing deployment manifest/,
    );
  });

  it("rejects manifests whose chainId disagrees with the topology", () => {
    const t = getTopology("local");
    const skewed = { ...t, hub: { ...t.hub, chainId: 99999 }, clients: [] };
    expect(() => loadAllManifests(flat(FIXTURES), skewed)).toThrow(/chainId/);
  });
});

describe("registry provider (central armada-deployments submodule)", () => {
  it("resolves demo1's sepolia hub + clients by chainId, with real addresses + deployBlock", () => {
    const all = loadAllManifests(demo1(), getTopology("sepolia"));
    expect(all[0]!.manifest.contracts.privacyPool).toBe(
      "0x014aC1dfC2Bde83d4be2CFFb5bea4dE942DAD77F",
    );
    expect(all[0]!.manifest.deployBlock).toBe(10893598);
    expect(all[1]!.manifest.contracts.privacyPoolClient).toBe(
      "0x83C80Fa61c5dA2A716326871025a5d0c2B9bD43f",
    );
    expect(all[1]!.manifest.hub).toEqual({
      domain: 0,
      privacyPool: "0x014aC1dfC2Bde83d4be2CFFb5bea4dE942DAD77F",
    });
    expect(loadYieldManifest(demo1(), getTopology("sepolia"))!.contracts.armadaYieldAdapter).toBe(
      "0x148A6A4588062dB433Fa8847017DB42bAc506458",
    );
  });

  it("missing instance fails loudly and specifically (mainnet posture)", () => {
    const src: DeploymentSource = {
      kind: "registry",
      root: REGISTRY_ROOT,
      environment: "mainnet",
      instance: "does-not-exist",
    };
    expect(() => loadAllManifests(src, getTopology("mainnet"))).toThrow(
      /Missing deployment registry instance.*mainnet\/does-not-exist\/manifest\.json/s,
    );
  });

  it("fails loudly when the instance lacks a topology chainId (demo1 has no mainnet chains)", () => {
    // demo1 is a testnet instance; loading it against the mainnet topology (chainId 1) must fail.
    expect(() => loadAllManifests(demo1(), getTopology("mainnet"))).toThrow(/chainId 1/);
  });
});

describe("buildConfig", () => {
  it("builds a full local config with defaults (v1 env names for RPC)", () => {
    const config = buildConfig(BASE_ENV as NodeJS.ProcessEnv, FIXTURES);
    expect(config.network).toBe("local");
    expect(config.cctpMode).toBe("mock");
    expect(config.rpcUrls.get(31337)).toBe("http://127.0.0.1:8545");
    expect(config.feeTtlSeconds).toBe(300);
    expect(config.feeVarianceBufferBps).toBe(2000);
    expect(config.profitMarginBps).toBe(0); // v1 default
    expect(config.shieldFeeBps).toBe(50); // = ArmadaFeeModule.baseArmadaTakeBps
    expect(config.stuckTxThresholdMs).toBe(600_000);
    expect(config.maxAttestationAgeMs).toBe(3_600_000);
    expect(config.relayRatePerMin).toBe(10);
    expect(config.getRatePerMin).toBe(60);
    expect(config.bodyLimitBytes).toBe(256 * 1024);
  });

  it("honors HUB_RPC/CLIENT_A_RPC/CLIENT_B_RPC and DEPLOY_ENV aliases", () => {
    const config = buildConfig(
      {
        DEPLOY_ENV: "local",
        DATABASE_URL: "postgres://x",
        ETH_USD_PRICE_STATIC: "3000",
        HUB_RPC: "http://hub:1111",
        CLIENT_A_RPC: "http://a:2222",
      } as NodeJS.ProcessEnv,
      FIXTURES,
    );
    expect(config.rpcUrls.get(31337)).toBe("http://hub:1111");
    expect(config.rpcUrls.get(31338)).toBe("http://a:2222");
    expect(config.rpcUrls.get(31339)).toBe("http://127.0.0.1:8547"); // default preserved
  });

  it("takes the first URL when an RPC env var holds a comma-separated list", () => {
    // The watcher pools comma-separated providers; the actor stays on a single provider
    // (first entry) so nonce views and receipt polling remain consistent.
    const config = buildConfig(
      {
        ...BASE_ENV,
        HUB_RPC: " http://hub:1111 , http://hub:2222",
      } as NodeJS.ProcessEnv,
      FIXTURES,
    );
    expect(config.rpcUrls.get(31337)).toBe("http://hub:1111");
  });

  it("rejects RPC env vars that are only commas/whitespace", () => {
    expect(() =>
      buildConfig({ ...BASE_ENV, HUB_RPC: " , " } as NodeJS.ProcessEnv, FIXTURES),
    ).toThrow(/Missing RPC URL.*HUB_RPC/);
  });

  it("CCTP_MODE: local defaults to mock; mainnet+mock is forbidden", () => {
    expect(buildConfig(BASE_ENV as NodeJS.ProcessEnv, FIXTURES).cctpMode).toBe("mock");
    expect(() =>
      buildConfig(
        { ...BASE_ENV, NETWORK: "mainnet", CCTP_MODE: "mock" } as NodeJS.ProcessEnv,
        FIXTURES,
      ),
    ).toThrow(/CCTP_MODE=mock is forbidden on mainnet/);
    expect(() =>
      buildConfig({ ...BASE_ENV, CCTP_MODE: "banana" } as NodeJS.ProcessEnv, FIXTURES),
    ).toThrow(/CCTP_MODE must be mock\|real/);
  });

  it("requires DATABASE_URL and a static price (ETH_USDC_PRICE alias accepted)", () => {
    expect(() =>
      buildConfig({ NETWORK: "local", ETH_USD_PRICE_STATIC: "3000" } as NodeJS.ProcessEnv, FIXTURES),
    ).toThrow(/DATABASE_URL/);
    expect(() =>
      buildConfig({ NETWORK: "local", DATABASE_URL: "postgres://x" } as NodeJS.ProcessEnv, FIXTURES),
    ).toThrow(/ETH_USD_PRICE_STATIC/);
    const config = buildConfig(
      { NETWORK: "local", DATABASE_URL: "postgres://x", ETH_USDC_PRICE: "2000" } as NodeJS.ProcessEnv,
      FIXTURES,
    );
    expect(config.ethUsdPriceStatic).toBe(2000);
  });

  it("non-local networks require ETH_USD_FEED_ADDRESS (§8.8)", () => {
    expect(() =>
      buildConfig(
        {
          NETWORK: "sepolia",
          DATABASE_URL: "postgres://x",
          ETH_USD_PRICE_STATIC: "3000",
          HUB_RPC: "https://rpc",
          CLIENT_A_RPC: "https://rpc",
          CLIENT_B_RPC: "https://rpc",
        } as NodeJS.ProcessEnv,
        FIXTURES,
      ),
    ).toThrow(/ETH_USD_FEED_ADDRESS/);
  });

  it("env-overridable thresholds enforce their minimums, v1 names first (§6.4)", () => {
    expect(() =>
      buildConfig(
        { ...BASE_ENV, RELAYER_STUCK_TX_THRESHOLD_MS: "30000" } as NodeJS.ProcessEnv,
        FIXTURES,
      ),
    ).toThrow(/RELAYER_STUCK_TX_THRESHOLD_MS/);
    expect(() =>
      buildConfig(
        { ...BASE_ENV, RELAYER_ATTESTATION_AGE_MS: "1000" } as NodeJS.ProcessEnv,
        FIXTURES,
      ),
    ).toThrow(/RELAYER_ATTESTATION_AGE_MS/);
  });

  it("missing RPC URL on non-local chains fails loudly", () => {
    expect(() =>
      buildConfig(
        {
          NETWORK: "sepolia",
          DATABASE_URL: "postgres://x",
          ETH_USD_PRICE_STATIC: "3000",
          ETH_USD_FEED_ADDRESS: "0x" + "11".repeat(20),
        } as NodeJS.ProcessEnv,
        FIXTURES,
      ),
    ).toThrow(/HUB_RPC/);
  });
});
