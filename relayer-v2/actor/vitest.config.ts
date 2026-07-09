// ABOUTME: Vitest configuration for the actor package unit and integration tests.
// ABOUTME: Integration tests requiring Postgres are gated on the ACTOR_TEST_PG_URL env var.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20000,
  },
});
