/**
 * Reads wallet-service's Application Service bearer tokens
 * (matrix-implementation-plan.md Phase 4 Steps 14/15) from the bare secret
 * files scripts/generate-matrix-secrets.ts writes under matrix/secrets/ —
 * the same files scripts/render-matrix-config.ts reads to render
 * matrix/appservice-registration.yaml. Not sourced from process.env: these
 * are generated secrets, not deployment config (see that script's header
 * comment for why).
 *
 *   - as_token: presented by wallet-service to Synapse's Client-Server API
 *     when acting as the AS (Step 15b/15c: /register, /login).
 *   - hs_token: presented by Synapse back to wallet-service's AS
 *     transaction-push endpoint (Step 15a) so it can authenticate inbound
 *     calls.
 *
 * Each reader takes an optional path override so callers (tests, mainly)
 * can point at a fixture file instead of the real matrix/secrets/ path —
 * generate-matrix-secrets.ts must have run for the real path to exist.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SECRETS_DIR = path.join(MODULE_DIR, '..', '..', 'matrix', 'secrets');

export const AS_TOKEN_PATH = path.join(SECRETS_DIR, 'appservice-as-token.txt');
export const HS_TOKEN_PATH = path.join(SECRETS_DIR, 'appservice-hs-token.txt');

function readTokenFile(filePath: string): string {
  return readFileSync(filePath, 'utf8').trim();
}

export function readAppServiceAsToken(filePath: string = AS_TOKEN_PATH): string {
  return readTokenFile(filePath);
}

export function readAppServiceHsToken(filePath: string = HS_TOKEN_PATH): string {
  return readTokenFile(filePath);
}
