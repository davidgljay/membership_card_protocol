#!/usr/bin/env -S npx tsx
/**
 * Generates and stores the Matrix-subsystem credentials from
 * implementation-plan.md's Phase 2 Steps 7 and 7c, plus Phase 4 Step 14:
 *
 *   1. Synapse's Ed25519 signing key      (Step 7)
 *   2. Synapse's registration_shared_secret (Step 7)
 *   3. The membership registry's encryption key (Step 7c)
 *   4. The Application Service's as_token/hs_token (Step 14)
 *
 * ~~The watcher's Synapse login credential (Step 7b)~~ was removed
 * 2026-07-12, before this note was written: research confirmed there is no
 * Synapse Admin API endpoint for force-removing a room member, so the
 * watcher never needs to log in as anything — force-part is an in-process
 * `ModuleApi.update_room_membership` call using `MATRIX_ENFORCEMENT_USER_ID`
 * (an account identifier, not a credential; see `.env.example`). This
 * script generated a `watcher-credential.json` login password for a design
 * that had already been superseded — dead code, found and removed during
 * Phase 6 Step 22's live-boot verification (2026-07-16), where it was never
 * actually consumed by anything.
 *
 * Usage: npx tsx scripts/generate-matrix-secrets.ts
 * Requires: DATABASE_URL + SECRETS_BACKEND config reachable the same way
 * any other wallet-service process reads it (.env in local dev). Run this
 * after `docker compose up postgres` and after migrations are applied.
 *
 * ---------------------------------------------------------------------
 * Design note: what "stored via the existing secrets abstraction" means
 * when the consumer isn't wallet-service itself.
 * ---------------------------------------------------------------------
 * `SecretsService.encryptSecret`/`decryptSecret` (src/secrets/) is built
 * for secrets wallet-service itself later decrypts and uses in-process
 * (see src/routes/accounts-create.ts's service_secret). None of these four
 * credentials fit that shape: all four are read directly, at process
 * startup, by the `synapse` container / its Python policy module — a
 * different runtime that has no way to call wallet-service's API to
 * unwrap a DEK, and shouldn't need to just to boot.
 *
 * Resolution used here, uniformly for all four credentials (per the plan's
 * Step 7 "documented equivalent pattern" escape hatch):
 *
 *   - The raw key material is generated once, here, and written directly
 *     to a file under matrix/secrets/ (gitignored — see .gitignore) that
 *     is volume-mounted into the `synapse` container. That mounted file is
 *     the thing the consuming process actually reads at its own startup.
 *     This repo's existing precedent for "a value another process needs
 *     to read from disk" is docker-compose.yml's env-var-per-config-value
 *     pattern (e.g. MATRIX_MEMBERSHIP_REGISTRY_PATH); a mounted secrets
 *     file plus an env var pointing at it is the same idea applied to
 *     values too sensitive to pass as plain env vars.
 *   - Independently, `SecretsService.encryptSecret` is still used — to
 *     encrypt the same raw material into an audit-trail row in
 *     wallet-service's own Postgres (`matrix_credentials`, see
 *     src/matrix-credentials.ts), exactly the way every other credential
 *     in this deployment is tracked. This is bookkeeping/recovery, not the
 *     runtime path: nothing about the `synapse` container's boot sequence
 *     depends on this row existing or being reachable.
 *
 * This keeps one convention across all Matrix credentials (this script, and
 * the AS token in Step 15) rather than a different one-off scheme per
 * credential, while being honest that the *decrypt* half of SecretsService's
 * usual flow doesn't apply to a process outside wallet-service.
 *
 * ---------------------------------------------------------------------
 * Cross-language handoff (TypeScript generates, Python/Synapse consumes)
 * ---------------------------------------------------------------------
 * matrix/secrets/homeserver.signing.key
 *   Synapse's own key format (`ed25519 <key_id> <base64_seed>`). Synapse
 *   reads this itself, natively, via homeserver.yaml's `signing_key_path`
 *   (Synapse config supports a dedicated `_path` variant for this one —
 *   see docker-compose.yml's comment on the synapse service). Step 6
 *   (homeserver.yaml, not yet written as of this script) must set
 *   `signing_key_path: /data/secrets/homeserver.signing.key`.
 *
 * matrix/secrets/registration-shared-secret.yaml
 *   **Resolved 2026-07-11** (was left as an open (a)/(b) choice for Step 6):
 *   Synapse's config schema has no `_path` variant for
 *   `registration_shared_secret` (confirmed against the current
 *   homeserver_sample_config docs) — it must be inlined as a literal value
 *   in a config file Synapse loads, unlike the signing key. Rather than a
 *   custom entrypoint wrapper, this script writes the value pre-wrapped as
 *   its own tiny YAML file (`registration_shared_secret: "<value>"`).
 *   Synapse's docker image supports repeating `--config-path`/`-c`, so
 *   Step 6's Dockerfile/compose command passes this file as a second
 *   config path alongside `homeserver.yaml` — no templating or entrypoint
 *   scripting needed, just Synapse's own multi-config-file merge. A plain
 *   `registration-shared-secret.txt` (bare value, no YAML wrapper) is
 *   also written alongside it, for a human/audit reader who wants the raw
 *   value without parsing YAML.
 *
 * ~~matrix/secrets/watcher-credential.json~~ — removed 2026-07-12 (see this
 * file's top-level note). The watcher force-parts a revoked card's shadow
 * account via an in-process `ModuleApi.update_room_membership(sender=
 * MATRIX_ENFORCEMENT_USER_ID, ...)` call, not a login — there is no
 * password to generate. `MATRIX_ENFORCEMENT_USER_ID` still needs kick-level
 * power in every card-gated room, granted at room creation
 * (`matrix_room.md`), but that's a Matrix-side permission grant on an
 * account identifier, not a secret this script produces.
 *
 * matrix/secrets/membership-registry.key
 *   32 raw random bytes, base64url-encoded (one line, no other framing —
 *   matches the same encoding WEBCRYPTO_MASTER_KEY uses for the analogous
 *   AES-256 key on the wallet-service side, for consistency). The Python
 *   policy module base64url-decodes this file's (whitespace-trimmed)
 *   contents at its own startup to get the raw key, and uses it with
 *   whatever AES-256-GCM implementation is idiomatic in Python (e.g.
 *   `cryptography.hazmat`) to encrypt/decrypt the membership registry
 *   (`matrix_join_attestation_and_revocation.md §2a`) in-process on every
 *   join/post. The module reads the path via a config value —
 *   `MATRIX_MEMBERSHIP_REGISTRY_KEY_PATH` — a sibling of the already-
 *   defined `MATRIX_MEMBERSHIP_REGISTRY_PATH` (matrix_synapse_module.md's
 *   config schema), passed as a container env var per docker-compose.yml's
 *   existing convention, not fetched from wallet-service at runtime.
 *
 * matrix/secrets/appservice-as-token.txt, matrix/secrets/appservice-hs-token.txt
 *   (Step 14) Bare bearer tokens (32 random bytes, hex, one line — same
 *   shape as registration-shared-secret.txt above) for wallet-service's
 *   Application Service registration (`matrix/appservice-registration.yaml.
 *   template`, rendered by scripts/render-matrix-config.ts). `as_token` is
 *   what wallet-service presents to Synapse's Client-Server API when acting
 *   as the AS; `hs_token` is what Synapse presents back to wallet-service's
 *   AS transaction-push endpoint (Step 15) so it can authenticate inbound
 *   calls. Written as their own bare files (not inlined directly into a
 *   pre-built appservice-registration.yaml the way registration-shared-
 *   secret.yaml is) because, unlike that file, most of
 *   appservice-registration.yaml's content (namespaces regex, url,
 *   sender_localpart, id) is ordinary non-secret template structure — it
 *   goes through the same render-matrix-config.ts template-rendering path
 *   as homeserver.yaml, with these two files supplying just the two secret
 *   values that path substitutes in alongside the env-var-sourced ones.
 */

import { randomBytes, randomInt, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';
import { createSecretsService } from '../src/secrets/index.js';
import { getPool } from '../server/db/client.js';
import { recordMatrixCredential } from '../src/matrix-credentials.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SECRETS_DIR = path.join(SCRIPT_DIR, '..', 'matrix', 'secrets');

const KEY_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function randomKeyId(): string {
  let suffix = '';
  for (let i = 0; i < 6; i++) {
    suffix += KEY_ID_ALPHABET[randomInt(KEY_ID_ALPHABET.length)];
  }
  return `a_${suffix}`;
}

/** Synapse's signing.key line format: "ed25519 <key_id> <base64_seed>". */
function generateSynapseSigningKeyFile(): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  const der = privateKey.export({ type: 'pkcs8', format: 'der' });
  // Ed25519 PKCS8 DER for a bare private key is a fixed 48 bytes; the raw
  // 32-byte seed is always the trailing 32 bytes (fixed ASN.1 prefix for
  // this key type/size — verified against Node's own output, not assumed).
  if (der.length !== 48) {
    throw new Error(`generate-matrix-secrets: unexpected Ed25519 PKCS8 DER length ${der.length}, expected 48.`);
  }
  const seed = der.subarray(der.length - 32);
  const base64Seed = seed.toString('base64'); // Synapse/signedjson use standard (not url-safe) base64, unpadded
  const unpadded = base64Seed.replace(/=+$/, '');
  const keyId = randomKeyId();
  return `ed25519 ${keyId} ${unpadded}\n`;
}

function writeSecretFile(filePath: string, contents: string | Buffer): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, contents, { mode: 0o600 });
  chmodSync(filePath, 0o600); // belt-and-suspenders in case the platform's umask widened it on write
}

async function main(): Promise<void> {
  const config = loadConfig();
  const secretsService = createSecretsService(config);
  const pool = getPool();

  mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });

  // --- Step 7: Synapse signing key ---
  const signingKeyPath = path.join(SECRETS_DIR, 'homeserver.signing.key');
  const signingKeyContents = generateSynapseSigningKeyFile();
  writeSecretFile(signingKeyPath, signingKeyContents);
  await recordMatrixCredential(pool, secretsService, {
    credentialName: 'synapse_signing_key',
    plaintext: Buffer.from(signingKeyContents, 'utf8'),
    keyFilePath: signingKeyPath,
    description:
      "Synapse homeserver Ed25519 signing key (signing.key format). Consumed directly by Synapse via homeserver.yaml's signing_key_path — this DB row is an audit/recovery record only.",
  });

  // --- Step 7: Synapse registration_shared_secret ---
  const registrationSecretPath = path.join(SECRETS_DIR, 'registration-shared-secret.txt');
  const registrationSecretYamlPath = path.join(SECRETS_DIR, 'registration-shared-secret.yaml');
  const registrationSecret = randomBytes(32).toString('hex');
  writeSecretFile(registrationSecretPath, `${registrationSecret}\n`);
  writeSecretFile(registrationSecretYamlPath, `registration_shared_secret: "${registrationSecret}"\n`);
  await recordMatrixCredential(pool, secretsService, {
    credentialName: 'synapse_registration_shared_secret',
    plaintext: Buffer.from(registrationSecret, 'utf8'),
    keyFilePath: registrationSecretYamlPath,
    description:
      "Synapse registration_shared_secret, pre-wrapped as its own YAML config file (Synapse's docker image merges multiple --config-path files, so no entrypoint templating is needed) — Step 6 passes this as a second config path alongside homeserver.yaml. This DB row is an audit/recovery record only.",
  });

  // --- Step 7c: membership registry encryption key ---
  const registryKeyPath = path.join(SECRETS_DIR, 'membership-registry.key');
  const registryKey = randomBytes(32);
  writeSecretFile(registryKeyPath, `${registryKey.toString('base64url')}\n`);
  await recordMatrixCredential(pool, secretsService, {
    credentialName: 'matrix_membership_registry_key',
    plaintext: registryKey,
    keyFilePath: registryKeyPath,
    description:
      "AES-256 key (raw, base64url in the file) for the membership registry's encryption at rest (matrix_join_attestation_and_revocation.md §2a). Consumed directly by the Python policy module at its own startup via MATRIX_MEMBERSHIP_REGISTRY_KEY_PATH; this DB row is an audit/recovery record only.",
  });

  // --- Step 14: Application Service as_token/hs_token ---
  // Same shape/generation as Step 7's registration_shared_secret (32 random
  // bytes, hex) — see this script's header comment for why these are bare
  // token files rather than a pre-built appservice-registration.yaml.
  const asTokenPath = path.join(SECRETS_DIR, 'appservice-as-token.txt');
  const asToken = randomBytes(32).toString('hex');
  writeSecretFile(asTokenPath, `${asToken}\n`);
  await recordMatrixCredential(pool, secretsService, {
    credentialName: 'matrix_appservice_as_token',
    plaintext: Buffer.from(asToken, 'utf8'),
    keyFilePath: asTokenPath,
    description:
      "as_token for wallet-service's Matrix Application Service registration (matrix/appservice-registration.yaml.template) — presented by wallet-service to Synapse's Client-Server API when acting as the AS. Consumed by scripts/render-matrix-config.ts, which substitutes it into the rendered appservice-registration.yaml; this DB row is an audit/recovery record only.",
  });

  const hsTokenPath = path.join(SECRETS_DIR, 'appservice-hs-token.txt');
  const hsToken = randomBytes(32).toString('hex');
  writeSecretFile(hsTokenPath, `${hsToken}\n`);
  await recordMatrixCredential(pool, secretsService, {
    credentialName: 'matrix_appservice_hs_token',
    plaintext: Buffer.from(hsToken, 'utf8'),
    keyFilePath: hsTokenPath,
    description:
      "hs_token for wallet-service's Matrix Application Service registration (matrix/appservice-registration.yaml.template) — presented by Synapse back to wallet-service's AS transaction-push endpoint (Step 15) so it can authenticate inbound calls. Consumed by scripts/render-matrix-config.ts; this DB row is an audit/recovery record only.",
  });

  console.log('Matrix credentials generated:');
  console.log(`  - ${signingKeyPath}`);
  console.log(`  - ${registrationSecretPath}`);
  console.log(`  - ${registrationSecretYamlPath}`);
  console.log(`  - ${registryKeyPath}`);
  console.log(`  - ${asTokenPath}`);
  console.log(`  - ${hsTokenPath}`);
  console.log('Audit records upserted into matrix_credentials (encrypted, no plaintext logged).');
  console.log('None of these paths are committed to git — confirm matrix/secrets/ is covered by .gitignore.');

  await pool.end();
}

main().catch((err) => {
  console.error('generate-matrix-secrets failed:', err);
  process.exitCode = 1;
});
