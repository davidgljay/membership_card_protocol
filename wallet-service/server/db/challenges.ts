/**
 * Single-use, expiring challenge store backing the three challenge/response
 * auth flows in Phase 2 (implementation-plan.md §Step 2.1, §Step 2.2,
 * §Step 2.4): new-account creation, passkey login, and post-recovery
 * keyring rotation. Table: `auth_challenges` (Step 2.0 migration).
 */

import type { Pool } from 'pg';

export type ChallengePurpose = 'account_creation' | 'passkey_login' | 'keyring_rotation';

const CHALLENGE_BYTES = 32;
const CHALLENGE_TTL_SECONDS = 5 * 60;

export interface IssuedChallenge {
  challenge: string;
  expiresAt: Date;
}

export async function issueChallenge(
  pool: Pool,
  purpose: ChallengePurpose,
  cardHash: string | null
): Promise<IssuedChallenge> {
  const challenge = Buffer.from(crypto.getRandomValues(new Uint8Array(CHALLENGE_BYTES))).toString(
    'base64url'
  );
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000);

  await pool.query(
    `INSERT INTO auth_challenges (purpose, card_hash, challenge, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [purpose, cardHash, challenge, expiresAt]
  );

  return { challenge, expiresAt };
}

/**
 * Atomically consumes a challenge: succeeds at most once per issued
 * challenge, and only before expiry. The UPDATE...RETURNING is the
 * concurrency boundary — two simultaneous requests racing on the same
 * challenge value can only ever have one win.
 */
export async function consumeChallenge(
  pool: Pool,
  purpose: ChallengePurpose,
  cardHash: string | null,
  challenge: string
): Promise<boolean> {
  const { rows } = await pool.query(
    `UPDATE auth_challenges
     SET consumed = true
     WHERE purpose = $1
       AND challenge = $2
       AND consumed = false
       AND expires_at > now()
       AND card_hash IS NOT DISTINCT FROM $3
     RETURNING id`,
    [purpose, challenge, cardHash]
  );
  return rows.length > 0;
}
