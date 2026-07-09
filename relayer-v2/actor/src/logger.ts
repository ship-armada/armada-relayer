// ABOUTME: Structured JSON logger (pino) with privacy hygiene: never logs IPs, keys,
// ABOUTME: mnemonics, viewing keys, or full calldata (spec §10.2, P4).
import { pino } from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "armada-actor" },
  redact: {
    paths: [
      "req.headers",
      "ip",
      "remoteAddress",
      "privateKey",
      "mnemonic",
      "viewingKey",
      "*.privateKey",
      "*.mnemonic",
      "*.viewingKey",
    ],
    remove: true,
  },
});

/** Truncates calldata to its 4-byte selector + ellipsis for log lines (§10.2). */
export function calldataPreview(data: string): string {
  return data.length > 10 ? `${data.slice(0, 10)}…(${(data.length - 2) / 2} bytes)` : data;
}

export type Logger = typeof logger;
