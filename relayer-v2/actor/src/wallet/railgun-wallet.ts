// ABOUTME: Railgun 0zk wallet boot per §6.5: mnemonic required (boot-fail if absent), LevelDB
// ABOUTME: on a persistent volume, mnemonic never logged. SDK behind a dynamic import (STUB-2).
import { logger } from "../logger.js";
import type { ActorConfig } from "../config/env.js";

export interface RailgunWalletService {
  walletId: string;
  railgunAddress: string; // 0zk address — the only loggable identifiers (§6.5)
  /**
   * Decrypts the first note of a synthetic transact calldata via the relayer viewing key
   * and returns the USDC amount destined to this relayer (broadcaster fee check, §6.2.5).
   */
  extractFeeNoteUsdcAmount(chainId: number, syntheticTransactCalldata: string): Promise<bigint>;
}

export function assertValidMnemonic(mnemonic: string | null): asserts mnemonic is string {
  if (!mnemonic) {
    throw new Error(
      "RELAYER_RAILGUN_MNEMONIC is required — the actor boot-fails without the 0zk wallet (§6.5)",
    );
  }
  const words = mnemonic.trim().split(/\s+/);
  if (words.length !== 12 && words.length !== 24) {
    throw new Error(
      `RELAYER_RAILGUN_MNEMONIC must be 12 or 24 words, got ${words.length}`,
    );
  }
}

/**
 * Boots the Railgun engine + wallet from the configured mnemonic.
 *
 * STUB-2 (.context/deviations.md): the SDK-backed implementation could not be verified
 * against v1's modules/railgun-wallet.ts in this workspace. It dynamically imports
 * @railgun-community/wallet (pinned in v1 at wallet 10.8.1 / engine 9.5.1, spec S6) and
 * fails the boot loudly if the SDK is not installed or its API differs.
 */
export async function bootRailgunWallet(config: ActorConfig): Promise<RailgunWalletService> {
  assertValidMnemonic(config.railgunMnemonic);
  const mnemonic = config.railgunMnemonic;

  let sdk: Record<string, unknown>;
  try {
    sdk = (await import("@railgun-community/wallet" as string)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      "Railgun SDK (@railgun-community/wallet) is not installed/loadable. The actor cannot " +
        "verify broadcaster fees without it. Install the v1-pinned versions (wallet 10.8.1 / " +
        `engine 9.5.1, spec S6). Underlying error: ${(err as Error).message}`,
    );
  }

  // Documented SDK boot sequence; see STUB-2 for the verification caveat.
  const { startRailgunEngine, createRailgunWallet } = sdk as {
    startRailgunEngine: (...args: unknown[]) => Promise<unknown>;
    createRailgunWallet: (
      encryptionKey: string,
      mnemonic: string,
      creationBlockNumbers: unknown,
    ) => Promise<{ id: string; railgunAddress: string }>;
  };
  if (typeof startRailgunEngine !== "function" || typeof createRailgunWallet !== "function") {
    throw new Error("Railgun SDK API mismatch: expected startRailgunEngine/createRailgunWallet");
  }

  const levelDb = await createLevelDb(config.railgunDbPath);
  await startRailgunEngine(
    "armada-actor",
    levelDb,
    false, // shouldDebug
    undefined, // artifact store (defaults)
    false, // useNativeArtifacts
    true, // skipMerkletreeScans — the actor only decrypts its own fee notes
  );
  // Encryption key: derived once per volume; stored beside the LevelDB (not a secret of
  // the same class as the mnemonic — it encrypts the local DB only).
  const encryptionKey = await loadOrCreateDbEncryptionKey(config.railgunDbPath);
  const wallet = await createRailgunWallet(encryptionKey, mnemonic, undefined);

  if (
    config.broadcasterRailgunAddress &&
    wallet.railgunAddress !== config.broadcasterRailgunAddress
  ) {
    throw new Error(
      `BROADCASTER_RAILGUN_ADDRESS assertion failed: derived 0zk address ` +
        `${wallet.railgunAddress} != configured ${config.broadcasterRailgunAddress}`,
    );
  }
  logger.info(
    { walletId: wallet.id, railgunAddress: wallet.railgunAddress },
    "railgun wallet ready",
  );

  return {
    walletId: wallet.id,
    railgunAddress: wallet.railgunAddress,
    async extractFeeNoteUsdcAmount(chainId: number, calldata: string): Promise<bigint> {
      const extract = (sdk as Record<string, unknown>)[
        "extractFirstNoteERC20AmountMapFromTransactionRequest"
      ] as ((...args: unknown[]) => Promise<Record<string, bigint>>) | undefined;
      if (typeof extract !== "function") {
        // Fail closed: the caller treats any extractor error as FEE_INSUFFICIENT (§6.2.5).
        throw new Error(
          "Railgun SDK API mismatch: extractFirstNoteERC20AmountMapFromTransactionRequest missing",
        );
      }
      const map = await extract(wallet.id, networkForChain(chainId), { data: calldata }, false);
      let total = 0n;
      for (const amount of Object.values(map)) total += BigInt(amount);
      return total;
    },
  };
}

async function createLevelDb(path: string): Promise<unknown> {
  const { default: Level } = (await import("leveldown" as string)) as {
    default: (path: string) => unknown;
  };
  return Level(path);
}

async function loadOrCreateDbEncryptionKey(dbPath: string): Promise<string> {
  const { existsSync, readFileSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const keyPath = join(dirname(dbPath), "railgun-db-key");
  if (existsSync(keyPath)) return readFileSync(keyPath, "utf8").trim();
  const { randomBytes } = await import("node:crypto");
  const key = randomBytes(32).toString("hex");
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}

function networkForChain(chainId: number): string {
  // Railgun SDK network names for the chains we submit through. Local anvil chains reuse
  // the Ethereum network definition (v1 behavior; STUB-2 verification caveat applies).
  const names: Record<number, string> = {
    1: "Ethereum",
    11155111: "EthereumSepolia",
    31337: "Hardhat",
  };
  return names[chainId] ?? "Hardhat";
}
