# code-card: `ipfs_card.md` vs. actual implementation

**Unit type:** Phase 3, Step A (spec-vs-code diff, read-only).
**Spec reviewed:** `specs/object_specs/ipfs_card.md` (full).
**Code reviewed:** `press/src/functions/{crypto.ts,log.ts,issuance.ts}`, `press/src/ipfs/client.ts`, `press/src/handlers/{issue.ts,update.ts,sub-card.ts,open-offer.ts}`, `press/server/tasks/reconcile-cids.ts`, `press/src/serialization.ts`; on the client/verification side, `app-sdk/packages/app-sdk/src/verification/CardVerifier.ts` and (as its actual implementation) `membership_card_verifier/packages/verifier/src/{types.ts,stages/stage3.ts,stages/stage4.ts}` and `membership_card_verifier/packages/verifier-rpc-provider/src/index.ts`.

No spec or code file was modified. This file is the only output.

---

## Finding 1 — LogEntry construction has not adopted the `card_state`/`history` redesign

**Spec (`ipfs_card.md` §5, amended 2026-07-16):** every post-genesis `LogEntry` must carry a full repost of current state (`card_state`) and a flat, oldest-first `history` array of every predecessor CID, so a reader needs only the current head object to get full state + full provenance.

**Code (`press/src/functions/log.ts`, `appendLogEntry`, lines ~81–100):** constructs a `LogEntry` with only the pre-redesign shape — `version`, `code`, `entry_type`, `prev_log_root`, `notify_holder`, `intent_signature`, `field_updates`/`revocation`, `updater_message`, and (after signing) `press_signature`. There is no `card_state` field and no `history` field anywhere in the object being assembled or signed.

**Which side is correct:** the spec is correct; this is a real, expected implementation gap, not a spec error. The redesign is dated the same day as this review (2026-07-16) — the code has simply not caught up yet. **Recommended resolution: code needs to implement the new design** — `appendLogEntry` must be extended to (a) fetch/derive the full current field state and populate `card_state`, and (b) accumulate a `history` array (fetching the previous head's own `history` and appending its CID, or deriving it from `prev_log_root` walk on first migration). This is a Phase-3/Phase-4 implementation task, not a spec fix.

**Related, smaller gap in the same function:** `version` is hardcoded to `const version = 1; // Increment logic requires full chain walk; placeholder for Phase 3.` (log.ts line 79) — every `LogEntry` a press writes today gets `version: 1` regardless of how many prior entries exist, which also contradicts §7's "monotonically increasing from `1`" versioning rule. This should be fixed as part of the same implementation work, since a correct `history` array trivially yields the next version number (`history.length + 1`).

---

## Finding 2 — Ancestor/chain-walk code still assumes `log_head_cid` always points directly at a `CardDocument`, never a `LogEntry`

**Spec (§5, §6):** `log_head_cid` may point at either the genesis `CardDocument` or the most recent `LogEntry`; a reader must inspect the fetched object to tell which. The current "card" state for a post-genesis card lives in the head `LogEntry`'s `card_state`, not in the original genesis document.

**Code (`membership_card_verifier/packages/verifier/src/stages/stage3.ts`, lines 90–95):** when walking the ancestry chain, fetches `cardEntry.log_head_cid`, decrypts it, and does `JSON.parse(...) as CardDocument` unconditionally — it never checks whether the fetched object is actually a `LogEntry` (in which case the fields it needs, e.g. `ancestry_pubkeys`, would live under `card_state` on the new design, or would need `field_updates` folding under the old one). For any ancestor card that has ever had a post-genesis update, this code would read stale/wrong data (the genesis document's fields, not current state) once updates exist.

**Which side is correct:** the spec is correct (and consistent with what `protocol-objects.md §3` already required even before the 2026-07-16 amendment — the current model was never "genesis document only"). This is a pre-existing gap that predates the `history`/`card_state` amendment and is broader than just this amendment. **Recommended resolution:** file as a code TODO/bug for the verifier package (`code-verifier-sdk` unit territory, since `stage3.ts` lives in `membership_card_verifier`, not `press/`) — flagging here because it directly affects whether "the card" as read by app-sdk/verifier callers is ever actually current for a card with post-genesis history. Not treating as a spec error.

## Finding 2b — `RpcProvider.getLogEntries` / `LogEntry` type in the verifier package models a completely different, older architecture

**Code (`membership_card_verifier/packages/verifier/src/types.ts` line 49–53):** `LogEntry` there is `{ update_code: number; effective_date: string; cid: string }`, and `RpcProvider.getLogEntries(cardAddress)` (`verifier-rpc-provider/src/index.ts` line 41) is implemented as an on-chain contract call `contract.getLogEntries(cardAddress)`, i.e. it assumes log entries are individually queryable on-chain events/state, not that they're one IPFS `prev_log_root` chain the client must walk via `ipfs.fetch`.

This doesn't match `protocol-objects.md §3`'s `LogEntry` (an IPFS JSON object with `version`, `code`, `entry_type`, `prev_log_root`, `intent_signature`, `press_signature`, and now `card_state`/`history`) under either the old or new design, and it doesn't match `registry_contract.md`'s `CardEntry` schema either (which per §6 of `ipfs_card.md` stores only `log_head_cid`, not a per-entry-queryable log). `ipfs_card.md` §5 itself says the pre-amendment design required "the verifier package's `RpcProvider.getLogEntries()`" to walk the IPFS chain via `prev_log_root` — but the actual `getLogEntries` in code doesn't do an IPFS walk at all; it queries a different on-chain data source entirely with a different, much simpler entry shape.

**Which side is correct:** neither "side" is simply wrong — this looks like a leftover from an earlier iteration of the protocol design (on-chain-enumerable log entries) that predates the current IPFS-log-chain model described throughout `protocol-objects.md §3` and `ipfs_card.md` §5/§6. **Recommended resolution: ESCALATE TO DAVID for scoping**, not folded into the routine fix list — this is more than a docs lag; it means stage 4 (revocation-status / log-update checking) in the verifier is running against a data source (`contract.getLogEntries`) that may not exist in the actual `registry_contract.md` ABI at all (worth cross-checking against `code-contracts`/`code-verifier-sdk` findings). This properly belongs to the `code-verifier-sdk` unit's scope but is noted here because it's the direct implementation of the "history" concept `ipfs_card.md` §5 describes.

---

## Finding 3 — Content encryption formula matches the spec exactly

**Spec (§3):** `content_key = HKDF-SHA3-256(recipient_pubkey, info="card-content-v1")`; `ciphertext = AES-256-GCM(content_key, canonical_RFC8785_JSON(signed_card_document), random 96-bit nonce)`.

**Code:**
- `press/src/functions/crypto.ts` `deriveContentKey`: `hkdf(sha3_256, recipientPubkey, undefined, 'card-content-v1', 32)` — matches exactly (HKDF-SHA3-256, no salt, correct info string, 32-byte/256-bit output).
- `aes256gcmEncrypt`: AES-256-GCM, `randomBytes(12)` (96-bit) nonce, layout `nonce || ciphertext || tag` — matches.
- Verifier-side counterpart (`membership_card_verifier/packages/verifier/src/crypto.ts`, referenced from `stage3.ts` as `hkdfSha3256`/`aes256gcmDecrypt`) implements the same derivation and is used identically for ancestor-card decryption.
- Canonicalization (`press/src/serialization.ts`, re-exporting `canonicalize` from the verifier package) implements RFC 8785 JCS (sorted keys, no whitespace) as required by §1/§3.

**No divergence.** This part of the spec is accurately implemented.

---

## Finding 4 — Pinning provider is Filebase, not Piñata; spec's Piñata claims (inherited from `press.md`) don't match either the code or, apparently, current operational reality

**Spec (`ipfs_card.md` §4):** "Uploads and pins the encrypted bytes via Piñata in a single call (`pinToIPFS`, `press.md §5.1`)"; reconciliation "calls Piñata's idempotent `pinByHash` for each CID found." This is a direct summary of `press.md §3.4/§3.5`, which itself says (line 66, 178–206 of `press.md`): "IPFS pinning is provided by **Piñata**," names the `pinata` npm SDK, `PINATA_JWT`/`PINATA_GATEWAY_URL` config vars, and error codes `P-10`/`P-24` framed around Piñata specifically.

**Code:** every actual pinning code path uses **Filebase** (S3-compatible object storage + a separate Filebase Pinning API), not Piñata:
- `press/src/ipfs/client.ts`: uses `@aws-sdk/client-s3` against `https://s3.filebase.com`, bucket `membership_card_protocol`, reads `config.FILEBASE_KEY`/`FILEBASE_SECRET`/`FILEBASE_GATEWAY_URL`. No `pinata` package import anywhere in `press/src`.
- `press/server/tasks/reconcile-cids.ts`: explicitly named/commented "ensures each CID is pinned in Filebase via their Pinning API" (`https://api.filebase.io/v1/ipfs/pins`), using `FILEBASE_KEY`/`FILEBASE_SECRET` HTTP basic-style auth — not `pinata.pinByHash`.
- Client/verifier side: `app-sdk`'s `createCardVerifier` factory defaults to a bundled `FilebaseIpfsProvider` from `@membership-card-protocol/verifier-ipfs-provider` — there is no Piñata-branded provider package in the repo at all.

The P-10/P-24 error codes themselves are preserved in code (`client.ts` throws `pressCode: 'P-10'` for CID mismatch and `'P-24'` for upload failure) — only the underlying provider changed, not the error taxonomy.

**Which side is correct:** the code. This looks like a deliberate, mature provider migration (dedicated S3 + separate Pinning-API integration, a `checkFilebaseHealth` startup check, idempotent-upload key derivation, matching Filebase's documented CID-return-via-metadata behavior) — not an accidental drift. `press.md` itself is out of scope for this unit (it belongs to `code-press`), but because `ipfs_card.md` §4 directly restates `press.md`'s Piñata claims as its own authoritative-for-code account of pinning, this divergence propagates into `ipfs_card.md` too.

**Recommended resolution:** update `ipfs_card.md` §4 to describe Filebase (S3 upload + HeadObject CID capture + gateway fetch + separate Filebase Pinning API for reconciliation) instead of Piñata, once/if `press.md` itself is corrected by the `code-press` unit — the two should be fixed together so they don't re-diverge. Flagging here rather than silently editing, per Phase 3 instructions (spec-vs-code fixes go through Step B/C, not this file).

---

## Finding 5 — CID validation happens, but by a different mechanism than the spec describes, and with no explicit hash-algorithm check

**Spec (§4):** "re-derives the expected CID from the uploaded bytes and confirms it matches what [the pinning provider] returned. A mismatch is a hard error (`P-10`)." This implies the press independently computes a CID (i.e., hashes the bytes itself and encodes as a CID) and string-compares it to the provider's returned CID.

**Code (`press/src/ipfs/client.ts`, `pinToIPFS`):** does not independently compute/derive a CID from the uploaded bytes at all. Instead it re-fetches the content from the gateway *using the CID Filebase returned* and does a byte-for-byte comparison of the refetched content against the originally uploaded content (`bytesEqual`). If they match, the CID is accepted; if not (or if the fetch fails), it's a hard `P-10` error — same failure semantics and same error code as the spec describes, but a materially different check: it validates "the CID Filebase gave us actually resolves to our content" rather than "the CID Filebase gave us is the CID our content bytes hash to."

**Practical effect:** for the two properties the spec cares about (no wrong-content and no un-derivable CID silently accepted), the code's round-trip check is a reasonable/arguably-equivalent substitute in the common case, and it never lets a mismatched CID through — the P-10 guard still fires. But it does **not** independently verify the hash-algorithm claim in §4 ("only SHA2-256 is currently produced and validated by the reference press implementation") — the code never inspects the CID's multihash prefix at all; it fully trusts whatever algorithm Filebase's response happens to use. If Filebase's default ever silently changed (e.g. to a different hash), this code would not detect or reject it, and would keep functioning (since it never parses the CID), silently invalidating §4's "only SHA2-256" claim without any code-level enforcement backing it up.

**Which side is correct:** this is a middle case — not a security bug (the mismatch guard still functions, and `registry_contract.md §3.1`'s 64-byte field already accommodates SHA2-256/SHA3-256/BLAKE3 CIDs, so a hash-algorithm change wouldn't break on-chain storage), but the spec's specific wording ("re-derives the expected CID from the...bytes") overstates precision the code doesn't have. **Recommended resolution:** soften `ipfs_card.md` §4's wording to describe what the code actually does (fetch-and-byte-compare round-trip validation) rather than "re-derives the expected CID," and drop or hedge the "only SHA2-256 is...validated" clause, since nothing in the code actually validates the algorithm — it's an assumption based on Filebase's current default behavior, not an enforced invariant. Not escalating as a security issue since the P-10 mismatch guard is real and effective for its actual purpose (preventing wrong content/CID pairs from being used) — flagging as a wording-precision fix.

---

## Summary table

| # | Topic | Spec correct? | Code correct? | Action |
|---|---|---|---|---|
| 1 | `card_state`/`history` on new `LogEntry` writes | Yes | No — old diff-only shape, plus hardcoded `version: 1` | Code needs to implement new design (expected gap, spec is very recent) |
| 2 | Chain-walk fetches head CID and assumes it's always a `CardDocument` | Yes | No | File as verifier-package bug (`code-verifier-sdk` territory), not a spec issue |
| 2b | `LogEntry`/`getLogEntries` shape in verifier package models on-chain-enumerable entries, not the IPFS `prev_log_root`/`history` chain | Ambiguous — looks like leftover older architecture | No, doesn't match either design | **ESCALATE TO DAVID** — scoping question, likely also touches `code-contracts`/`code-verifier-sdk` |
| 3 | Content-encryption formula (HKDF-SHA3-256 + AES-256-GCM) | Yes | Yes | No action — matches |
| 4 | Pinning provider (Piñata vs. Filebase) | No — outdated, inherited from `press.md` | Yes | Update `ipfs_card.md` §4 (coordinate with `code-press` fix to `press.md`) |
| 5 | CID validation mechanism / SHA2-256-only claim | Overstated precision | Functionally adequate, but doesn't enforce hash-algorithm claim | Soften spec wording; not a security escalation |

No finding in this unit involves a load-bearing security/auth-boundary divergence rising to the "flag directly to David" bar in the implementation plan's Phase 3 instructions, **except Finding 2b**, which is flagged above for scoping reasons (it may indicate the verifier's revocation/log-update check is wired to a data source that doesn't match the actual on-chain contract surface — worth a real look rather than a routine fix-list entry).
