/**
 * Nitro plugin: runs once at server startup (before any request is handled).
 * Validates config, checks Piñata reachability, and marks the server ready.
 *
 * The `pressReady` flag is read by GET /health.
 */

import { loadConfig, type PressConfig } from '../../src/config.js';

// Module-level state shared across the process lifetime of a single invocation.
// In serverless contexts (Lambda, Workers) this resets per cold start.
let pressReady = false;
let pressStartupError: string | null = null;
let config: PressConfig | null = null;

export function getPressConfig(): PressConfig {
  if (!config) throw new Error('Press config not loaded');
  return config;
}

export function isPressReady(): boolean {
  return pressReady;
}

export function getPressStartupError(): string | null {
  return pressStartupError;
}

export default defineNitroPlugin(async () => {
  try {
    config = loadConfig();
  } catch {
    pressStartupError = 'Config validation failed — see process logs.';
    return;
  }

  // Check Piñata reachability with a lightweight auth test.
  try {
    const res = await fetch('https://api.pinata.cloud/data/testAuthentication', {
      headers: { Authorization: `Bearer ${config.PINATA_JWT}` },
    });
    if (!res.ok) {
      pressStartupError = `PINATA_JWT: authentication failed (HTTP ${res.status})`;
      return;
    }
  } catch (err) {
    pressStartupError = `PINATA_JWT: cannot reach Piñata API (${String(err)})`;
    return;
  }

  pressReady = true;
});
