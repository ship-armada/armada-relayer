// ABOUTME: ABI fragments + selector constants for the Railgun `transact` family — ported
// ABOUTME: verbatim from v1 relayer/lib/transact-shape.ts (must stay in sync with Globals.sol).

// ============ Selectors ============

/** PrivacyPool.transact(Transaction[]) — vanilla. */
export const TRANSACT_SELECTOR = "0xd8ae136a";

/** ArmadaYieldAdapter.lendAndShield(Transaction, bytes32, ShieldCiphertext) — yield deposit. */
export const LEND_AND_SHIELD_SELECTOR = "0xf2987ad1";

/** ArmadaYieldAdapter.redeemAndShield(Transaction, bytes32, ShieldCiphertext) — yield withdraw. */
export const REDEEM_AND_SHIELD_SELECTOR = "0x0793b70e";

/**
 * PrivacyPool.atomicCrossChainUnshield(Transaction, uint32, address, bytes32, uint256) —
 * cross-chain unshield. Same single-Transaction-in-arg-0 shape as the yield wrappers, so the
 * synthetic-transact rewrite applies here too.
 */
export const ATOMIC_CROSS_CHAIN_UNSHIELD_SELECTOR = "0xe484d408";

/** The wrappers that need synthetic-transact re-encoding before the SDK helper can decode. */
export const WRAPPER_SELECTORS: ReadonlySet<string> = new Set([
  LEND_AND_SHIELD_SELECTOR,
  REDEEM_AND_SHIELD_SELECTOR,
  ATOMIC_CROSS_CHAIN_UNSHIELD_SELECTOR,
]);

// ============ Shared struct fragments ============

/**
 * Railgun Transaction struct ABI. Matches `contracts/railgun/logic/Globals.sol::Transaction`.
 * The order MUST match the Solidity definition exactly — ethers decodes by position, not name.
 */
const TRANSACTION_STRUCT =
  "tuple(" +
  "tuple(" +
  "tuple(uint256 x, uint256 y) a," +
  "tuple(uint256[2] x, uint256[2] y) b," +
  "tuple(uint256 x, uint256 y) c" +
  ") proof," +
  "bytes32 merkleRoot," +
  "bytes32[] nullifiers," +
  "bytes32[] commitments," +
  "tuple(" +
  "uint16 treeNumber," +
  "uint72 minGasPrice," +
  "uint8 unshield," +
  "uint64 chainID," +
  "address adaptContract," +
  "bytes32 adaptParams," +
  "tuple(" +
  "bytes32[4] ciphertext," +
  "bytes32 blindedSenderViewingKey," +
  "bytes32 blindedReceiverViewingKey," +
  "bytes annotationData," +
  "bytes memo" +
  ")[] commitmentCiphertext" +
  ") boundParams," +
  "tuple(" +
  "bytes32 npk," +
  "tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token," +
  "uint120 value" +
  ") unshieldPreimage" +
  ")";

const SHIELD_CIPHERTEXT_STRUCT = "tuple(bytes32[3] encryptedBundle, bytes32 shieldKey)";

// ============ Function ABIs ============

/** Vanilla PrivacyPool.transact — used both for verification of incoming requests AND for
 *  encoding synthetic calldata when normalising wrapper calls. */
export const TRANSACT_ABI: readonly string[] = [
  `function transact(${TRANSACTION_STRUCT}[] _transactions)`,
];

/** Wrapper functions that carry a single Transaction in arg 0. The other args are passed
 *  through but the verifier doesn't inspect them — only the embedded Transaction matters for
 *  fee-payment verification. */
export const WRAPPER_ABIS: readonly string[] = [
  `function lendAndShield(${TRANSACTION_STRUCT} _transaction, bytes32 _npk, ${SHIELD_CIPHERTEXT_STRUCT} _shieldCiphertext)`,
  `function redeemAndShield(${TRANSACTION_STRUCT} _transaction, bytes32 _npk, ${SHIELD_CIPHERTEXT_STRUCT} _shieldCiphertext)`,
  `function atomicCrossChainUnshield(${TRANSACTION_STRUCT} _transaction, uint32 destinationDomain, address finalRecipient, bytes32 destinationCaller, uint256 maxFee)`,
];
