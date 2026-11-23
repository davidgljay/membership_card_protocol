import { defineConfig } from "vitest/config";
// The default run is the tests that need no processes. `hostile/` needs the broker, the fake enclave and the simulated chain
// (`hostile/run-hostile.sh`, which uses `hostile/vitest.config.ts`).
export default defineConfig({ test: { exclude: ["hostile/**", "**/node_modules/**"] } });
