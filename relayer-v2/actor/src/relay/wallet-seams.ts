// ABOUTME: Narrow interfaces the fee verifiers need from the relayer's Railgun wallet, injected as
// ABOUTME: seams so the verifiers stay unit-testable without the native SDK (impls in railgun-wallet.ts).

/**
 * Decrypts the relayer-destined ERC20 note amounts from a (synthetic) transact call using the
 * relayer 0zk wallet's viewing key. Mirrors v1's
 * `wallet.extractFirstNoteERC20AmountMap(TXIDVersion.V2_PoseidonMerkle, chain, txRequest,
 * false, privacyPoolAddress)`. Returns tokenAddress -> amount. Used by the broadcaster-output fee path.
 */
export interface NoteAmountExtractor {
  extractFirstNoteERC20AmountMap(tx: { to: string; data: string }): Promise<Record<string, bigint>>;
}

/**
 * Reconstructs the note public key a fee note WOULD have if shielded to the relayer with `random` —
 * `npk = Poseidon(relayerMasterPublicKey, random)`. A match against an on-chain fee note's npk proves
 * the note is addressed to the relayer. Used by the redeem and gasless shielded-fee-note paths.
 */
export interface FeeNoteNpkDeriver {
  deriveFeeNoteNpk(random: string): bigint;
}
