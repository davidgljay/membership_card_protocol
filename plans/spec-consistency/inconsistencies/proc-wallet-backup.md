# Inconsistency Log: `proc-wallet-backup`

**Unit:** `specs/process_specs/wallet_backup_and_recovery.md`
**Reviewed against:** `specs/object_specs/wallet_sdk.md`, `specs/object_specs/wallet.md`, `specs/process_specs/open_offer_acceptance_new_wallet.md`, `specs/process_specs/open_offer_acceptance_existing_wallet.md`, `specs/process_specs/card_updates.md`, `specs/process_specs/subcard_creation_policy.md`, `specs/process_specs/notification_relay.md`, `specs/process_specs/card_migration.md`, and the implementation-plan's specific request to re-verify the wallet_sdk.md §5.3 step-numbering fix (#32) and the OQ-WALLET-2 wording.

---

## Finding 1 — `wallet_sdk.md` §5.3 mislabels the YubiKey backup-registration step range (residual defect in Fix #32)

**Specs:** `specs/object_specs/wallet_sdk.md` §5.3 vs. `specs/process_specs/wallet_backup_and_recovery.md` Process 1.

Fix #32 (per `wallet_sdk.md`'s own changelog) reordered `setupWallet`'s prose so device sub-card generation/registration (Steps 7–10) precedes backup registration (Steps 11–13), "matching `wallet_backup_and_recovery.md §Process 1`'s numbered step order." That part of the fix is **correct** — `wallet_backup_and_recovery.md` does have "Device sub-card setup" at Steps 7–10, followed by "Synced passkey backup registration" at Steps 11–13.

However, §5.3's prose then continues: "...synced-passkey backup registration (always) → optional YubiKey backup (Steps 11–13)." This mislabels the **YubiKey** backup registration's step range. In `wallet_backup_and_recovery.md`:
- Steps 11–13 = **Synced passkey backup registration** (default, automatic).
- Steps 14–15 = **YubiKey backup registration** (opt-in upgrade).

So the parenthetical "(Steps 11–13)" attached to "optional YubiKey backup" is wrong — it's citing the synced-passkey range for the YubiKey step, not the YubiKey range. It should read "(Steps 14–15)".

**Recommended resolution:** In `wallet_sdk.md` §5.3, change "optional YubiKey backup (Steps 11–13)" to "optional YubiKey backup (Steps 14–15)". This is a small follow-on correction to Fix #32, not a reversal of it — the device-sub-card-before-backup-registration reordering itself is confirmed correct.

---

## Finding 2 — `wallet_backup_and_recovery.md` has an internal step-numbering defect that invites exactly this kind of citation error

**Spec:** `specs/process_specs/wallet_backup_and_recovery.md`, Process 2a vs. Process 3.

Process 2a ("Synced Passkey Recovery")'s steps are numbered 1–10, ending with Step 10: "Recovery is complete. Proceed to Process 3 (post-recovery re-registration)."

Process 3 ("Post-Recovery Re-registration")'s steps then start at **10** as well: "10. The holder registers with a new primary service..." through "13. Update backup registrations...". Process 3 does not restart its own numbering at 1, and its first step number (10) duplicates Process 2a's last step number (10) — a different step with the same number in the same document.

This isn't a cross-document contradiction, but it's a real defect worth flagging given the task's explicit concern with step-number citation accuracy: `wallet.md`'s OQ-WALLET-2 and `wallet_sdk.md` §5.6 both cite "Process 3 Step 13" / "Process 3" by number, and Finding 1 above shows a step-range mislabeling already slipped through a prior fix. Numbering that restarts cleanly at 1 for each named process (or is otherwise unambiguous) would reduce the chance of another such citation error.

**Recommended resolution:** Renumber Process 3's steps to start at 1 (i.e., 1–4 instead of 10–13), or otherwise make clear that Process 3's numbering is independent of Process 2a/2b's. Low priority — no downstream citation is currently broken by it (OQ-WALLET-2's "Step 13" reference is unambiguous in context), but it's a latent hazard.

---

## Finding 3 — OQ-WALLET-2 (`wallet.md`) confirmed accurate

**Specs:** `specs/object_specs/wallet.md` §9 OQ-WALLET-2 vs. `specs/process_specs/wallet_backup_and_recovery.md` Process 3 Step 13.

OQ-WALLET-2 states: "`wallet_backup_and_recovery.md` Process 3 Step 13 calls for revoking old backup registrations after post-recovery re-registration; this is not implemented." Process 3 Step 13 in the current document reads: "**Update backup registrations:** Register a new synced passkey blob under the new `decryption_key`... If a YubiKey is registered, re-wrap... **Revoke the old backup registrations at the backup service.**" This matches OQ-WALLET-2's characterization exactly — no discrepancy. No action needed; this is a confirmation, not a new finding.

---

## Finding 4 — Process spec describes a single-pass keyring/service_secret bootstrap; wallet.md and wallet_sdk.md describe an actual two-call provisional/final sequence not reflected in the process spec

**Specs:** `specs/process_specs/wallet_backup_and_recovery.md` Process 1 Steps 3–6 (and Process 3 Step 10) vs. `specs/object_specs/wallet.md` §7.2–7.3 vs. `specs/object_specs/wallet_sdk.md` §5.3, §5.6.

`wallet_backup_and_recovery.md` describes wallet creation as a linear sequence: (3) primary service generates `service_secret` → (4) derive `decryption_key` → (5) initialize keyring, encrypt with the (already-derived) real `decryption_key`, store, broadcast → (6) clear master key. No mention of a provisional/placeholder keyring blob or a second network call.

`wallet_sdk.md` §5.3 describes `setupWallet` as actually implementing: "master ML-DSA-44 keypair generation → device-bound passkey → the two-call `service_secret` bootstrap (`POST /accounts/challenge` → `POST /accounts`) → re-encrypt under the real `decryption_key` → `PUT /accounts/{card_hash}/keyring` with `rotate_service_secret: false` → keyring persistence → ..." — i.e., the client must submit some `encrypted_keyring_blob` in the initial `POST /accounts` call (per `wallet.md` §7.2's request schema, which requires this field) *before* it can have derived the real `decryption_key` from the just-issued `service_secret`, then perform a second `PUT .../keyring` call to install the properly re-encrypted blob without a second unwanted `service_secret` rotation (`wallet.md` §7.3's `rotate_service_secret: false` semantics exist specifically for this reason).

The same gap recurs for re-registration: `wallet_sdk.md` §5.6 says `recoverWallet` re-registers "via the same provisional/final two-call bootstrap §5.3 uses," but `wallet_backup_and_recovery.md` Process 3 Step 10 again describes only a single-pass re-encryption/broadcast, with no provisional-then-final two-call detail.

**Recommended resolution:** Update `wallet_backup_and_recovery.md` Process 1 (Steps 3–6) and Process 3 (Step 10) to describe the actual two-call bootstrap/re-registration sequence (initial call with a provisional keyring blob → derive real `decryption_key` → re-encrypt → second call with `rotate_service_secret: false` to install the final blob), matching what `wallet.md` §7.2–7.3 and `wallet_sdk.md` §5.3/§5.6 already document as implemented. The process spec is the one that's out of date here — it's silent on a mechanism both the object spec and the SDK spec describe as load-bearing (avoiding an accidental second `service_secret` rotation).

---

## Finding 5 — Error Paths table assumes holder-initiated 9xx revocation, which conflicts with `card_updates.md`'s default authorization model

**Specs:** `specs/process_specs/wallet_backup_and_recovery.md` Error Paths table vs. `specs/process_specs/card_updates.md` §Phase 3 Step 7.

`wallet_backup_and_recovery.md`'s Error Paths table, row "Recovery completed by attacker before holder notices," says: "Holder must issue 910 (full wallet compromise suspected) revocations on all cards and work with each policy's issuer to obtain successor cards."

`card_updates.md` §Phase 3 Step 7 states the default authorization rule for revocations: "Confirm the updater's card chain satisfies `revocation_permissions` for the given code range. If `revocation_permissions` is absent from the policy, the default applies: **8xx by holder or issuer, 9xx by issuer only**."

Under this default, a holder cannot unilaterally submit a 9xx (910) revocation on their own card — only the issuer can, absent a policy that explicitly grants the holder that authority via a custom `revocation_permissions` predicate. `wallet_backup_and_recovery.md`'s error-path guidance ("Holder must issue 910... revocations") states the holder can do this without qualifying it against the default authorization model — the very next clause ("and work with each policy's issuer...") implies awareness that the issuer is involved for successor cards, but the revocation itself is still framed as the holder's own action.

**Recommended resolution:** Either (a) qualify the Error Paths row to say the holder must *request* a 910 revocation from each policy's issuer (since under the default `revocation_permissions`, only the issuer can post a 9xx entry), or (b) if some deployments are expected to grant holders 9xx authority via policy override, note that this depends on the specific policy's `revocation_permissions` rather than stating it as a universal holder capability.

---

## Finding 6 — Process 3 Step 12's use of code 811 for a "lost or stolen" device blends two distinct code semantics

**Specs:** `specs/process_specs/wallet_backup_and_recovery.md` Process 3 Step 12 vs. `specs/process_specs/subcard_creation_policy.md` §Revocation — 8xx (Quiet) vs. `specs/object_specs/wallet_sdk.md` §6.4.

`wallet_backup_and_recovery.md` Process 3 Step 12 ("Deregister potentially-compromised sub-cards") says: "For each device sub-card that was active on the lost device: submit a revocation intent (**code 811 — device sub-card lost or stolen**) via the card update flow."

`subcard_creation_policy.md`'s 8xx code table (also reflected verbatim in `wallet_sdk.md` §6.4's `SubCardRevocationCode` type) defines these as distinct:
- **810** — "Sub-card's signing key compromised"
- **811** — "App installation lost or uninstalled; this sub-card only"

811 is the benign/cooperative code (e.g., app uninstalled, device retired normally); 810 is the code for suspected key compromise. `wallet_backup_and_recovery.md`'s Step 12 is specifically about sub-cards on a device that triggered wallet *recovery* (i.e., a lost or potentially-stolen device where the key material's fate is unknown) and labels this single scenario "811 — lost or stolen," collapsing 810's compromise semantics into 811's benign-loss code.

**Recommended resolution:** Clarify Step 12 to select the code based on the actual scenario: 811 if the device is merely lost/replaced with no suspicion of key extraction, 810 if there's reason to suspect the signing key itself may have been compromised (the more likely case motivating a *recovery* flow in the first place). At minimum, drop "or stolen" from the 811 label, or split Step 12 into two cases.

---

## Minor / no-action note — variable-name vs. wire-field-name divergence (not a contradiction)

`wallet_backup_and_recovery.md`'s prose uses `wrapped_decryption_key_cloud` / `wrapped_decryption_key_yubikey` as descriptive variable names in Steps 12/14/Process 2a/2b, but the actual wire format (this document's own Steps 13/14 JSON, and `wallet.md`'s `backup_registrations` table / endpoint schemas) uniformly uses the field name `wrapped_blob`. This is internally consistent — the doc itself uses `wrapped_blob` in the JSON examples — just worth noting the prose labels could be mistaken for wire field names by a skimming reader. Not logging as a fix-list item; flagging only for awareness.

---

## Summary

6 findings logged (2 confirmations of already-correct/already-accurate material: Finding 3 confirms OQ-WALLET-2's wording is accurate; the ordering half of Fix #32 is confirmed correct). Substantive new findings: 1 (mislabeled step range in a just-applied Phase 1 fix), 2 (latent numbering defect), 4 (process spec missing the two-call bootstrap detail present in wallet.md/wallet_sdk.md), 5 (holder-vs-issuer 9xx authorization mismatch), 6 (811 vs. 810 semantic mismatch for lost/stolen devices).
