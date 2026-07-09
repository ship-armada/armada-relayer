// ABOUTME: Hub PrivacyPool event ABI (§5.1 catalogue). HAND-AUTHORED from Railgun V2 event
// ABOUTME: shapes (DEV-3): regenerate via `npm run watcher:abis` from real Hardhat artifacts.
export const PrivacyPoolAbi = [
  {
    type: "event",
    name: "Shield",
    inputs: [
      { name: "treeNumber", type: "uint256", indexed: false },
      { name: "startPosition", type: "uint256", indexed: false },
      {
        name: "commitments",
        type: "tuple[]",
        indexed: false,
        components: [
          { name: "npk", type: "bytes32" },
          {
            name: "token",
            type: "tuple",
            components: [
              { name: "tokenType", type: "uint8" },
              { name: "tokenAddress", type: "address" },
              { name: "tokenSubID", type: "uint256" },
            ],
          },
          { name: "value", type: "uint120" },
        ],
      },
      {
        name: "shieldCiphertext",
        type: "tuple[]",
        indexed: false,
        components: [
          { name: "encryptedBundle", type: "bytes32[3]" },
          { name: "shieldKey", type: "bytes32" },
        ],
      },
      { name: "fees", type: "uint256[]", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Transact",
    inputs: [
      { name: "treeNumber", type: "uint256", indexed: false },
      { name: "startPosition", type: "uint256", indexed: false },
      { name: "hash", type: "bytes32[]", indexed: false },
      {
        name: "ciphertext",
        type: "tuple[]",
        indexed: false,
        components: [
          { name: "ciphertext", type: "bytes32[4]" },
          { name: "blindedSenderViewingKey", type: "bytes32" },
          { name: "blindedReceiverViewingKey", type: "bytes32" },
          { name: "annotationData", type: "bytes" },
          { name: "memo", type: "bytes" },
        ],
      },
    ],
  },
  {
    type: "event",
    name: "Nullified",
    inputs: [
      { name: "treeNumber", type: "uint16", indexed: false },
      { name: "nullifier", type: "bytes32[]", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Unshield",
    inputs: [
      { name: "to", type: "address", indexed: false },
      {
        name: "token",
        type: "tuple",
        indexed: false,
        components: [
          { name: "tokenType", type: "uint8" },
          { name: "tokenAddress", type: "address" },
          { name: "tokenSubID", type: "uint256" },
        ],
      },
      { name: "amount", type: "uint256", indexed: false },
      { name: "fee", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "CrossChainUnshieldInitiated",
    inputs: [
      { name: "domain", type: "uint32", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "nonce", type: "uint64", indexed: false },
    ],
  },
] as const;
