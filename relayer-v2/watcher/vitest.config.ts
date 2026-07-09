// ABOUTME: Vitest configuration for the watcher package — pure-logic tests only (decode
// ABOUTME: helpers, manifest derivation, API helpers); indexing runs under Ponder itself.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
