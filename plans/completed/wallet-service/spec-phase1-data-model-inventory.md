# Phase 1, Step 1.2 — Data Model Inventory (from migrations, 2026-07-04)

Source: all 8 files in `wallet-service/server/db/migrations/`, applied in timestamp order, cross-checked against `server/db/*.ts` repo query code. This is the reconstructed **current-state** schema — not the Phase 1 sketch in `implementation-plan.md`, which is stale in several places (noted below).

## Current tables

**`holder_accounts`**
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `card_hash` | text, unique, not null | keccak256(card_pubkey) |
| `master_pubkey` | text, not null | ML-DSA-44 pubkey, base64url |
| `keyring_id` | text, not null | FK-by-convention into `keyring_blobs` (no hard FK) |
| `service_secret_enc` | text, not null | AES-256-GCM ciphertext |
| `service_secret_dek_enc` | text, not null | envelope-encrypted DEK |
| `webauthn_credential_id` | text, nullable | added in `phase2-auth`; unique when non-null (partial index) |
| `webauthn_public_key` | text, nullable | COSE public key, base64url |
| `webauthn_sign_count` | bigint, not null, default 0 | replay protection |
| `created_at` | timestamptz, not null | |

**`keyring_blobs`**
`keyring_id` (PK, text = keccak256(encrypted_blob)), `card_hash` (text, indexed), `encrypted_blob` (text, opaque), `received_at` (timestamptz). Unchanged since initial schema. Confirmed against `server/db/keyrings.ts`: insert is `ON CONFLICT (keyring_id) DO NOTHING` (idempotent replication), delete is unconditional (idempotent by nature — deleting an absent row is a no-op).

**`backup_registrations`**
`id` (PK uuid), `holder_id` (FK → holder_accounts, ON DELETE CASCADE), `type` (check: `synced_passkey`|`yubikey`), `wrapped_blob` (text, opaque), `notification_channels` (jsonb), `cancellation_pubkey` (text), `keyring_id` (text, **added in `phase3-recovery`** — not in the Phase 1 sketch; binds the backup to the keyring_id it can unwrap, independent of the account's *current* keyring_id), `created_at`.

**`recovery_windows`**
`id` (PK uuid), `backup_reg_id` (FK → backup_registrations), `initiated_at`, `expires_at`, `status` (check: `pending`|`cancelled`|`released`), `cancelled_at`, `released_at`. Unchanged since initial schema.

**`message_queue`** — **substantially changed since the Phase 1 sketch**
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `card_hash` | text, not null | |
| `subcard_hash` | text, **nullable** | added in `phase4-remove-umbral`; nullable only for pre-existing rows, always set on new rows |
| `payload` | text, not null | opaque ciphertext |
| `received_at` | timestamptz | |
| `cleared` | boolean, default false | |
| `cleared_at` | timestamptz, nullable | |
| `delivery_uuid` | uuid, nullable | added in `phase4-remove-umbral`; most recent relay UUID this row was handed to |

Indexes: `(card_hash, cleared)` (original), `(card_hash, subcard_hash, cleared)` (added), `delivery_uuid` (added).

**`uuid_pools`** — unchanged since initial schema: `uuid` (PK), `card_hash`, `subcard_hash`, `consumed` (bool), `registered_at`, `expires_at`. Index on `(card_hash, subcard_hash, consumed)`.

**`routing_table`** — `card_hash` (PK), `wallet_service_id`, `endpoint`, `type` (check: `card_registration`|`card_migration`), `announced_at`, `nonce` (unique), plus **`signatures` (jsonb, added in `phase4-routing`)** — the original announcement envelope's signature array, so `GET /bindings` can re-serve independently verifiable envelopes rather than just resolved fields.

**`routing_nonces`** — `nonce` (PK), `seen_at`. Unchanged.

**`kv_store`** — `key` (PK), `value` (jsonb), `expires_at`. Present since initial schema; this is the Postgres-backed fallback for Nitro's `storage()` abstraction on `node-server`/`aws-lambda` presets (session revocation + rate-limit counters), consistent with `strategic-plan.md`/`implementation-plan.md`'s description — not a discrepancy, just wasn't broken out as its own table in the Phase 1 plan's schema sketch.

**`auth_challenges`** — added in `phase2-auth`: `id` (PK), `purpose` (check: `account_creation`|`passkey_login`|`keyring_rotation`), `card_hash` (nullable — null for account_creation before the account exists), `challenge`, `expires_at`, `consumed`, `created_at`. Indexed on `(card_hash, purpose)`. **Not in the Phase 1 sketch at all** — the sketch didn't anticipate a shared challenge table across three auth flows.

**`notification_jobs`** — added in `phase3-recovery`, matches the Phase 1 sketch's `notification_jobs` closely, with one addition: `channel` check constraint is `'email' | 'sms' | 'webhook' | 'secondary_contact_email' | 'secondary_contact_sms'` (the sketch just said `secondary_contact` as one channel; code splits it into two typed sub-channels), plus `created_at` (not in the sketch).

**`subcard_action_nonces`** — final name after `generalize-subcard-action-nonces` renamed it from `subcard_uuid_registration_nonces`. `subcard_hash`, `nonce`, `action` (check: `register`|`deregister`), `seen_at`. PK is `(subcard_hash, action, nonce)`. **Entirely new since the Phase 1 sketch** — supports the signed-envelope replay protection added to UUID registration/deregistration (see endpoint inventory findings #2).

## Tables in the Phase 1 implementation-plan sketch that no longer exist

- **`reencryption_keys`** — created in `initial-schema`, dropped in `phase4-remove-umbral`. Matches `implementation-plan.md`'s own documented "DROPPED IN PHASE 4" note. Not a discrepancy — the plan already correctly documents this as historical.

## Discrepancies to carry into Phase 2

1. `message_queue`'s schema changed meaningfully (added `subcard_hash`, `delivery_uuid`) from the Phase 1 sketch, which predates the sender-side-encryption architecture change. `implementation-plan.md`'s Phase 1 Step 1.2 code block is stale for this table (though the Phase 4 prose elsewhere in the same document does describe the new behavior in words — the SQL sketch just wasn't updated to match).
2. `backup_registrations.keyring_id` and the full `auth_challenges` and `subcard_action_nonces` tables are absent from the Phase 1 schema sketch entirely (expected — they were added in later phases and the sketch was never revised). Not a "bug," but the object spec must document current state, not the Phase 1 sketch.
3. `notification_jobs.channel`'s split of `secondary_contact` into `secondary_contact_email`/`secondary_contact_sms` is a refinement beyond the strategic plan's `{ email, sms, webhook, secondary_contact }` channel shape — confirm this is consistent with how `notification-fanout.ts` and `notification-providers.ts` actually dispatch (Phase 1 Step 1.3 will touch this).
