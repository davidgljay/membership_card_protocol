import { defineConfig } from "vitest/config";
// The host's tests externalize @noble (the dependency tree needs two majors); the hostile tests import the host's own source.
export default defineConfig({ test: { environment: "node", include: ["hostile/**/*.test.ts"], testTimeout: 240_000, hookTimeout: 240_000, fileParallelism: false, server: { deps: { external: [/^@noble\//] } } } });
