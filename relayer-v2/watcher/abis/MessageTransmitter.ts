// ABOUTME: CCTP V2 MessageTransmitter event ABI (§5.1 catalogue). HAND-AUTHORED (DEV-3) from
// ABOUTME: Circle's MessageTransmitterV2; regenerate from real artifacts and diff.
export const MessageTransmitterAbi = [
  {
    type: "event",
    name: "MessageSent",
    inputs: [{ name: "message", type: "bytes", indexed: false }],
  },
  {
    type: "event",
    name: "MessageReceived",
    inputs: [
      { name: "caller", type: "address", indexed: true },
      { name: "sourceDomain", type: "uint32", indexed: false },
      { name: "nonce", type: "bytes32", indexed: true },
      { name: "sender", type: "bytes32", indexed: false },
      { name: "finalityThresholdExecuted", type: "uint32", indexed: false },
      { name: "messageBody", type: "bytes", indexed: false },
    ],
  },
] as const;
