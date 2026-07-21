/**
 * Request-orchestration logic for POST /accounts/{card_hash}/keyring/challenge
 * (implementation-plan.md §Step 2.4).
 *
 * Factored out of server/routes/accounts/[card_hash]/keyring/challenge.post.ts
 * so the OHTTP gateway (server/routes/ohttp/gateway.post.ts) can call the
 * exact same logic the plaintext route calls — same convention already
 * established by accounts-challenge.ts / accounts-create.ts. Setup and
 * recovery flows both go through this endpoint via the oblivious transport
 * (client-sdk's `setupWallet`/`recoverWallet`), so it needs to be reachable
 * through the gateway like the account-creation calls it immediately follows
 * — a client whose account-creation traffic is IP-hidden but whose
 * follow-up keyring rotation isn't would leak the same correlation OHTTP
 * routing exists to prevent.
 */

import type { Pool } from 'pg';
import { findAccountByCardHash } from '../../server/db/accounts.js';
import { issueChallenge } from '../../server/db/challenges.js';

export type KeyringChallengeOutcome =
  | { ok: true; challenge: string; expires_at: string }
  | { ok: false; statusCode: 400 | 404; statusMessage: string };

export async function handleKeyringChallenge(params: {
  pool: Pool;
  cardHash: string | undefined;
}): Promise<KeyringChallengeOutcome> {
  const { pool, cardHash } = params;
  if (!cardHash) {
    return { ok: false, statusCode: 400, statusMessage: 'card_hash is required.' };
  }

  const account = await findAccountByCardHash(pool, cardHash);
  if (!account) {
    return { ok: false, statusCode: 404, statusMessage: 'No account found for this card_hash.' };
  }

  const { challenge, expiresAt } = await issueChallenge(pool, 'keyring_rotation', cardHash);
  return { ok: true, challenge, expires_at: expiresAt.toISOString() };
}
