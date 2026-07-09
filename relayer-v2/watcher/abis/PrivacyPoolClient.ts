// ABOUTME: Client-chain PrivacyPoolClient event ABI (§5.1 catalogue). HAND-AUTHORED (DEV-3):
// ABOUTME: regenerate via `npm run watcher:abis` from real Hardhat artifacts and diff.
export const PrivacyPoolClientAbi = [
  {
    type: "event",
    name: "CrossChainShieldInitiated",
    inputs: [
      { name: "domain", type: "uint32", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "nonce", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "UnshieldReceived",
    inputs: [
      { name: "recipient", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;
