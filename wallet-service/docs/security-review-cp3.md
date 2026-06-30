# CP-3 Pre-Production Security Review

**Status:** Self-review complete. **Does not satisfy CP-3.** The implementation plan requires an *independent* review before production launch — by definition, the author of the code under review cannot provide that independence. This document is the starting checklist for that review, not a substitute for it. **Production deployment remains blocked on a genuine independent review by a human security reviewer (or a separate auditing process) until this notice is replaced.**

---

## (a) 72-hour timer integrity

**Question:** Can the 72-hour cancellation window be manipulated via clock skew or direct DB access?

**Findings:**

- `expires_at` is computed exactly once, at window creation, entirely server-side: `server/db/recovery.ts` `createRecoveryWindow` — `now() + make_interval(hours => 72)`, evaluated by Postgres's own clock. No request body field ever supplies a timestamp that reaches `recovery_windows`.
- Both gates that matter — `cancelRecoveryWindow` (must be `status = 'pending' AND expires_at > now()`) and `releaseRecoveryWindow` (must be `status = 'pending' AND expires_at < now()`) — are single atomic `UPDATE ... WHERE ...` statements evaluated by Postgres. There is no read-then-write gap an attacker could race.
- `GET /recovery/{id}/release`'s `Retry-After` header is computed from the Node process's own `Date.now()` (`server/routes/recovery/[recovery_id]/release.get.ts`), **not** from the authorization decision itself. Node-process clock skew could only ever make the advisory `Retry-After` value cosmetically wrong (telling a client to retry sooner or later than ideal) — it cannot affect whether release/cancellation is actually permitted, since that decision is made entirely inside the atomic Postgres statement. This was a deliberate design choice (confirmed by re-reading the code for this review, not new behavior).
- Direct database access bypasses all of this by construction — anyone who can run arbitrary SQL against `recovery_windows` can set `expires_at` to whatever they want. This is **not an application-layer vulnerability**; it's a deployment/access-control concern: database credentials must be scoped tightly (the wallet service's own DB role should not have superuser/replication privileges beyond what its queries need) and never exposed outside the application's own runtime environment. Flagging for the operator runbook, not fixable in app code.

**Self-review conclusion:** No code-level manipulation path found. Clock-skew resistance is structural (Postgres is the single source of truth for the actual gate; Node's clock only affects a cosmetic header). Database access-control hardening is an infra/ops responsibility, documented in `docs/operations.md`.

**Still needs independent review:** confirm this reasoning against the actual deployed Postgres configuration (connection pooling behavior, replica lag if read replicas are ever introduced — none exist today, but worth confirming `now()` always reflects the primary's clock at decision time, not a stale replica's).

## (b) Cancellation signature verification

**Question:** Is the ML-DSA-44 verification implementation correct?

**Findings:**

- `src/auth/master-card-signature.ts` `verifyMasterCardSignature` calls `ml_dsa44.verify(signature, challenge, publicKey)` — the documented `@noble/post-quantum` API order (confirmed against the same library's usage in `membership_card_verifier` and the press, which predates this implementation).
- The cancellation challenge is defined as the `recovery_id`'s own UTF-8 bytes (`server/routes/recovery/[recovery_id]/cancel.post.ts`): the route checks `challengeText !== recoveryId` (a plain string comparison, not constant-time) before ever calling `verifyMasterCardSignature`. `recovery_id` is a public identifier (visible in the route URL, not a secret), so a timing side-channel on this specific comparison leaks nothing — there's no secret value being compared. This binds the signature to *this* window specifically, preventing a signature captured for one recovery window from cancelling a different one (verified by a passing test in `test/recovery-repo.test.ts`'s sibling route tests in Phase 3, and live-tested in the Phase 3 milestone smoke test).
- `cancellation_pubkey` is always read from the `backup_registrations` row loaded via `findBackupRegistrationById` (keyed off `recovery.backup_reg_id`, itself loaded from the trusted `recovery_windows` row) — never taken from the request body. An attacker cannot substitute their own public key by sending one in the cancellation request.
- Malformed input (invalid base64url, wrong-length keys) is caught inside `verifyMasterCardSignature`'s try/catch and returns `false` rather than throwing — no crash or bypass path on malformed signatures.

**Self-review conclusion:** The call site and binding logic (challenge-to-window, pubkey-to-backup-registration) are correct by inspection and covered by tests. **The cryptographic correctness of `@noble/post-quantum`'s ML-DSA-44 implementation itself is out of scope for this self-review** — `@noble/post-quantum` has no independent security audit at time of writing (a limitation already flagged in code comments in `src/auth/master-card-signature.ts` and mirrored from the press's equivalent module). This is exactly the kind of question that requires either a cryptography-focused independent review or waiting for/commissioning an audit of the upstream library.

**Still needs independent review:** an actual cryptographic audit of `@noble/post-quantum`'s ML-DSA-44 implementation (upstream, not this codebase) before relying on it for production-grade security guarantees.

## (c) SecretsBackend configuration

**Question:** For `WebCryptoBackend`, is the master key a platform secret, not committed or logged anywhere? For `KmsBackend`, does the KMS key policy restrict access to the wallet service identity only?

**Findings:**

- Grepped every `console.*` call in `server/` and `src/` for any reference to `WEBCRYPTO_MASTER_KEY`, `KMS_KEY_ID`, or `WALLET_SERVICE_PRIVATE_KEY`: the only matches are error messages naming the *environment variable*, never its value (`src/config.ts`). `src/secrets/*.ts` (the modules that actually touch key material) has zero `console.*` calls at all.
- `WEBCRYPTO_MASTER_KEY` is never committed: `.env` is gitignored (`wallet-service/.gitignore`); `.env.example` documents the variable name with an empty value and instructions to generate one locally. The development value used throughout this implementation (`AAAA...`, a 32-byte zero key) only ever exists in the local `.env` file and CI's workflow-level secret injection — never in source control.
- The strategic plan (`plans/wallet-service/strategic-plan.md` §Secret Storage) documents the intended production posture: `WebCryptoBackend`'s master key as a Cloudflare Worker secret (or the AWS-preset equivalent), set via the platform's secret-management mechanism, not an environment variable baked into a deployed artifact.
- `KmsBackend` (`src/secrets/kms-backend.ts`) calls AWS KMS `Encrypt`/`Decrypt` directly via the AWS SDK, using whatever IAM credentials are available in the runtime environment (standard SDK credential resolution — no credentials are hardcoded or logged). The actual KMS key policy (which IAM principals may use the key) is an AWS-side configuration applied at deploy time, not something this codebase can enforce or verify — it must be confirmed against the real deployment's IAM policy document.

**Self-review conclusion:** No key material leaks into logs or source control anywhere in this codebase. The default `WebCryptoBackend` posture is sound by construction (no external dependency, no policy surface to misconfigure). `KmsBackend`'s actual security depends entirely on the deployed AWS KMS key policy, which exists outside this repository and cannot be verified by code review alone.

**Still needs independent review:** if `SECRETS_BACKEND=kms` is used in production, the actual KMS key policy document must be reviewed by someone with access to the AWS account to confirm it grants `kms:Decrypt`/`kms:Encrypt` only to the wallet service's specific execution role, not broader account access.

---

## Summary

| Item | Self-review result | Blocks production until |
|---|---|---|
| (a) 72h timer manipulation | No code-level path found; DB-access hardening is an ops task | DB credential scoping confirmed in deployed environment |
| (b) Cancellation signature verification | Call-site logic correct and tested; underlying ML-DSA-44 library unaudited | Independent cryptographic review of `@noble/post-quantum`, or a published audit |
| (c) SecretsBackend configuration | No leaks found in this codebase; KMS policy is external | KMS key policy reviewed against deployed IAM, if `SECRETS_BACKEND=kms` is used |

**This document does not close CP-3.** It narrows what an independent reviewer needs to focus on, but the plan's explicit instruction — "Block production launch on this review" — refers to a review this document cannot itself satisfy.
