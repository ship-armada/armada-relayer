// ABOUTME: Railgun 0zk wallet boot ported from v1 (lib/sdk/init.ts + relayer/modules/
// ABOUTME: railgun-wallet.ts): RailgunEngine.initForWallet, mnemonic wallet, fee-note extraction.
import { mkdirSync } from "node:fs";
import { logger } from "../logger.js";
import type { ActorConfig } from "../config/env.js";
import type { NoteAmountExtractor } from "../relay/broadcaster-fee-verifier.js";

export interface RailgunWalletService extends NoteAmountExtractor {
  walletId: string;
  railgunAddress: string; // 0zk address — the only loggable identifiers (§6.5)
}

// v1 constants (relayer/modules/railgun-wallet.ts / lib/sdk/wallet.ts). The encryption key
// encrypts the local LevelDB only — fixed POC constant, deliberately preserved from v1.
const ENGINE_WALLET_SOURCE = "armadarelay";
const DEFAULT_ENCRYPTION_KEY =
  "0101010101010101010101010101010101010101010101010101010101010101";

export function assertValidMnemonic(mnemonic: string | null): asserts mnemonic is string {
  if (!mnemonic) {
    throw new Error(
      "RELAYER_RAILGUN_MNEMONIC is required — the actor boot-fails without the 0zk wallet (§6.5)",
    );
  }
  const words = mnemonic.trim().split(/\s+/);
  if (words.length !== 12 && words.length !== 24) {
    throw new Error(`RELAYER_RAILGUN_MNEMONIC must be 12 or 24 words, got ${words.length}`);
  }
}

/**
 * Boots the Railgun engine + relayer wallet, mirroring v1:
 *   engine = RailgunEngine.initForWallet(source, leveldown(db), artifactGetter,
 *     quickSync stubs, merkleroot-validator stub, txid stub, debugger, skipMerkletreeScans=false)
 *   wallet = engine.createWalletFromMnemonic(DEFAULT_ENCRYPTION_KEY, mnemonic, 0, undefined)
 * SDK loaded via dynamic import so unit tests run without the native deps installed.
 */
export async function bootRailgunWallet(config: ActorConfig): Promise<RailgunWalletService> {
  assertValidMnemonic(config.railgunMnemonic);
  const mnemonic = config.railgunMnemonic;

  let engineMod: Record<string, any>;
  let sharedModels: Record<string, any>;
  let leveldownMod: Record<string, any>;
  let artifactsMod: Record<string, any>;
  try {
    engineMod = await import("@railgun-community/engine" as string);
    sharedModels = await import("@railgun-community/shared-models" as string);
    leveldownMod = await import("leveldown" as string);
    artifactsMod = await import("railgun-circuit-test-artifacts" as string);
  } catch (err) {
    throw new Error(
      "Railgun SDK not loadable — install @railgun-community/engine 9.5.1, " +
        "@railgun-community/shared-models 8.0.0, leveldown, railgun-circuit-test-artifacts " +
        `(v1-pinned versions, spec S6). Underlying error: ${(err as Error).message}`,
    );
  }

  const { RailgunEngine, TXIDVersion } = engineMod;
  const { assertArtifactExists, ChainType } = sharedModels;
  const leveldown = leveldownMod.default ?? leveldownMod;
  const { getArtifact } = artifactsMod;

  // Artifact getter ported from v1 lib/sdk/init.ts (test artifacts: 1x2, 2x2, 2x3, 8x4).
  const artifactCache = new Map<string, unknown>();
  const artifactGetter = {
    assertArtifactExists,
    getArtifacts: async (inputs: { nullifiers: bigint[]; commitmentsOut: bigint[] }) => {
      const key = `${inputs.nullifiers.length}x${inputs.commitmentsOut.length}`;
      const cached = artifactCache.get(key);
      if (cached) return cached;
      try {
        const testArtifact = getArtifact(inputs.nullifiers.length, inputs.commitmentsOut.length);
        const artifact = {
          wasm: testArtifact.wasm,
          zkey: testArtifact.zkey,
          vkey: testArtifact.vkey,
          dat: undefined,
        };
        artifactCache.set(key, artifact);
        return artifact;
      } catch (error) {
        throw new Error(
          `Failed to load artifacts for ${key}. Available circuits: 1x2, 2x2, 2x3, 8x4. Error: ${error}`,
        );
      }
    },
    getArtifactsPOI: async () => {
      throw new Error("POI artifacts not available");
    },
  };

  const engineDebugger = {
    log: (msg: string) => {
      if (process.env.DEBUG_ENGINE) logger.debug({ msg }, "engine");
    },
    error: (error: Error) => logger.error({ err: error.message }, "engine error"),
    verboseScanLogging: false,
  };

  mkdirSync(config.railgunDbPath, { recursive: true });
  const db = leveldown(config.railgunDbPath);

  const engine = await RailgunEngine.initForWallet(
    ENGINE_WALLET_SOURCE,
    db,
    artifactGetter,
    // quick-sync stubs (v1: relayer scans nothing; it only decrypts its own fee notes)
    async () => ({ commitmentEvents: [], unshieldEvents: [], nullifierEvents: [] }),
    async () => [],
    async () => true, // merkleroot validator stub
    async () => ({ txidIndex: undefined, merkleroot: undefined }),
    engineDebugger,
    false, // skipMerkletreeScans
  );

  const wallet = await engine.createWalletFromMnemonic(
    DEFAULT_ENCRYPTION_KEY,
    mnemonic,
    0, // derivationIndex — fixed (v1)
    undefined, // creationBlockNumbers — relayer doesn't scan history
  );
  const railgunAddress: string = wallet.getAddress();

  if (config.broadcasterRailgunAddress) {
    if (!config.broadcasterRailgunAddress.startsWith("0zk")) {
      throw new Error("BROADCASTER_RAILGUN_ADDRESS must be a 0zk… Railgun address");
    }
    if (railgunAddress !== config.broadcasterRailgunAddress) {
      throw new Error(
        `BROADCASTER_RAILGUN_ADDRESS assertion failed: derived 0zk address ` +
          `${railgunAddress} != configured ${config.broadcasterRailgunAddress}`,
      );
    }
  }
  logger.info({ walletId: wallet.id, railgunAddress }, "railgun wallet ready");

  const hubChainId = config.topology.hub.chainId;
  const chain = { type: ChainType.EVM, id: hubChainId };

  return {
    walletId: wallet.id,
    railgunAddress,
    // v1 broadcaster-fee-verifier.ts:153 — decrypts the first note of each output under the
    // relayer viewing key, scoped to notes addressed to us, keyed by token address.
    async extractFirstNoteERC20AmountMap(tx: { to: string; data: string }) {
      const map: Record<string, bigint> = await wallet.extractFirstNoteERC20AmountMap(
        TXIDVersion.V2_PoseidonMerkle,
        chain,
        { to: tx.to, data: tx.data },
        false, // useRelayAdapt
        tx.to, // privacy pool address (the synthetic transact target)
      );
      return map;
    },
  };
}
