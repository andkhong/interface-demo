import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests launch real browsers against the fake app; run files one at a time.
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 60_000,
  },
});
