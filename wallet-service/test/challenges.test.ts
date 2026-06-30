import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { issueChallenge, consumeChallenge } from '../server/db/challenges.js';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://wallet_service:wallet_service@localhost:5433/wallet_service';

describe('auth_challenges (Step 2.1/2.2/2.4 shared challenge store)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('issues a challenge that can be consumed exactly once', async () => {
    const { challenge, expiresAt } = await issueChallenge(pool, 'account_creation', null);
    expect(challenge.length).toBeGreaterThan(0);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

    const firstConsume = await consumeChallenge(pool, 'account_creation', null, challenge);
    expect(firstConsume).toBe(true);

    const secondConsume = await consumeChallenge(pool, 'account_creation', null, challenge);
    expect(secondConsume).toBe(false);
  });

  it('scopes consumption to the matching card_hash', async () => {
    const cardHash = `0xtest-${crypto.randomUUID()}`;
    const { challenge } = await issueChallenge(pool, 'passkey_login', cardHash);

    const wrongCard = await consumeChallenge(pool, 'passkey_login', `${cardHash}-other`, challenge);
    expect(wrongCard).toBe(false);

    const rightCard = await consumeChallenge(pool, 'passkey_login', cardHash, challenge);
    expect(rightCard).toBe(true);
  });

  it('does not consume a challenge issued for a different purpose', async () => {
    const cardHash = `0xtest-${crypto.randomUUID()}`;
    const { challenge } = await issueChallenge(pool, 'keyring_rotation', cardHash);

    const wrongPurpose = await consumeChallenge(pool, 'passkey_login', cardHash, challenge);
    expect(wrongPurpose).toBe(false);

    const rightPurpose = await consumeChallenge(pool, 'keyring_rotation', cardHash, challenge);
    expect(rightPurpose).toBe(true);
  });

  it('rejects an expired challenge', async () => {
    const cardHash = `0xtest-${crypto.randomUUID()}`;
    const { challenge } = await issueChallenge(pool, 'account_creation', cardHash);

    await pool.query(
      `UPDATE auth_challenges SET expires_at = now() - interval '1 second' WHERE challenge = $1`,
      [challenge]
    );

    const result = await consumeChallenge(pool, 'account_creation', cardHash, challenge);
    expect(result).toBe(false);
  });
});
