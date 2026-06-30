import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import {
  createAccount,
  findAccountByCardHash,
  updateWebAuthnSignCount,
  updateServiceSecretAndKeyring,
} from '../server/db/accounts.js';
import { insertKeyringBlob } from '../server/db/keyrings.js';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://wallet_service:wallet_service@localhost:5433/wallet_service';

function randomAccountInput() {
  const suffix = crypto.randomUUID();
  return {
    cardHash: `0xtest-card-${suffix}`,
    masterPubkey: `pubkey-${suffix}`,
    keyringId: `0xtest-keyring-${suffix}`,
    serviceSecretEnc: `enc-${suffix}`,
    serviceSecretDekEnc: `dek-${suffix}`,
    webauthnCredentialId: `cred-${suffix}`,
    webauthnPublicKey: `cose-pubkey-${suffix}`,
  };
}

describe('holder_accounts repository', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates an account and finds it by card_hash', async () => {
    const input = randomAccountInput();
    const created = await createAccount(pool, input);
    expect(created.card_hash).toBe(input.cardHash);
    expect(created.webauthn_sign_count).toBe('0');

    const found = await findAccountByCardHash(pool, input.cardHash);
    expect(found?.id).toBe(created.id);
    expect(found?.webauthn_credential_id).toBe(input.webauthnCredentialId);
  });

  it('returns null for an unknown card_hash', async () => {
    const found = await findAccountByCardHash(pool, `0xdoes-not-exist-${crypto.randomUUID()}`);
    expect(found).toBeNull();
  });

  it('rejects a duplicate card_hash', async () => {
    const input = randomAccountInput();
    await createAccount(pool, input);
    await expect(createAccount(pool, input)).rejects.toThrow();
  });

  it('rejects a duplicate webauthn_credential_id across different accounts', async () => {
    const inputA = randomAccountInput();
    const inputB = randomAccountInput();
    await createAccount(pool, inputA);
    await expect(
      createAccount(pool, { ...inputB, webauthnCredentialId: inputA.webauthnCredentialId })
    ).rejects.toThrow();
  });

  it('updates the WebAuthn sign count after a verified login', async () => {
    const input = randomAccountInput();
    await createAccount(pool, input);

    await updateWebAuthnSignCount(pool, input.cardHash, 7);

    const found = await findAccountByCardHash(pool, input.cardHash);
    expect(found?.webauthn_sign_count).toBe('7');
  });

  it('replaces service_secret and keyring_id on rotation (Step 2.4)', async () => {
    const input = randomAccountInput();
    await createAccount(pool, input);
    await insertKeyringBlob(pool, input.keyringId, input.cardHash, 'original-blob');

    const newKeyringId = `0xrotated-${crypto.randomUUID()}`;
    await insertKeyringBlob(pool, newKeyringId, input.cardHash, 'rotated-blob');
    await updateServiceSecretAndKeyring(pool, input.cardHash, {
      keyringId: newKeyringId,
      serviceSecretEnc: 'new-enc',
      serviceSecretDekEnc: 'new-dek',
    });

    const found = await findAccountByCardHash(pool, input.cardHash);
    expect(found?.keyring_id).toBe(newKeyringId);
    expect(found?.service_secret_enc).toBe('new-enc');
    expect(found?.service_secret_dek_enc).toBe('new-dek');
  });
});
