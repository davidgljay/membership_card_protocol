import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globals: false,
    fileParallelism: false, // test files share a Redis instance — run sequentially
  },
});
