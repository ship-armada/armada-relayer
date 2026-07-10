// ABOUTME: Compile-time pin (spec §7.3, B3): asserts the watcher's quick-sync response is
// ABOUTME: structurally assignable to @railgun-community/engine's AccumulatedEvents. tsc-checked.
// An engine bump that moves the shape breaks `npm run typecheck`, forcing a coordinated re-pin.
// This file is type-only — no runtime engine import ships in the watcher bundle (S6).
import type { AccumulatedEvents } from "@railgun-community/engine";
import type { QuickSyncResponse } from "../src/api/quick-sync.js";

// If QuickSyncResponse ever diverges from the engine type, this assignment fails to compile.
type Assert<T extends U, U> = T;
type _PinResponse = Assert<QuickSyncResponse, Pick<AccumulatedEvents, keyof QuickSyncResponse>>;

// Each element type must also be assignable to the engine's element types.
type EngineCommitmentEvent = AccumulatedEvents["commitmentEvents"][number];
type EngineUnshield = AccumulatedEvents["unshieldEvents"][number];
type EngineNullifier = AccumulatedEvents["nullifierEvents"][number];

type _PinCommitmentEvent = Assert<
  QuickSyncResponse["commitmentEvents"][number],
  Pick<EngineCommitmentEvent, "txid" | "treeNumber" | "startPosition" | "blockNumber">
>;
type _PinUnshield = Assert<
  QuickSyncResponse["unshieldEvents"][number],
  Pick<EngineUnshield, "txid" | "toAddress" | "tokenType" | "tokenAddress" | "tokenSubID" | "amount" | "fee" | "blockNumber">
>;
type _PinNullifier = Assert<QuickSyncResponse["nullifierEvents"][number], EngineNullifier>;

// Suppress unused-type warnings (the assignments above are the whole point).
export type __QuickSyncTypePins = [_PinResponse, _PinCommitmentEvent, _PinUnshield, _PinNullifier];
