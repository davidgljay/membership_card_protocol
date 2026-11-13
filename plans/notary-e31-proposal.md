# Proposal: Card Reads in the Enclave (E31) and a Card-Forgery Finding

**Status:** Part B decided by David (2026-11-12): **B3, disclose and allow.** **Part A approved** (David, 2026-11-12), on the condition that **the enclave needs no network connection**. It doesn't: every read below is an enclave `fetch` over the existing vsock channel to the host (runtime §2: no network stack beyond vsock; §9 `fetch` / `fetch_result`), and the host does the network I/O. Content is checked by CID, and trust comes from the pinned roots and member signatures, never from where the bytes came from. Nothing implemented, and no spec text edited. It follows from erratum E31 in [notary-questions-5.3.md](notary-questions-5.3.md).

**Two parts:**
- **Part A** proposes how the enclave reads a policy, a job requester's chain and a governance list. These are mechanics, with low risk.
- **Part B** reports a security gap found while working on Part A. A hostile host can forge eligible contributors. **It needs your decision first**, because it changes what Part A's reads can be trusted for.

---

## Part B (read first): a hostile host can forge eligible contributors

### What the enclave relies on

Checks B5–B8 are a port of the verifier's Stages 2–4. Those stages establish a card's authenticity like this:
1. **The registry entry.** It says which IPFS document is the card's current head, and only an authorized press can write it.
2. **Decryption.** The content key is derived from the card's public key (ADR-006).
3. **The chain walk.** It follows `ancestry_pubkeys[0]` until an address equals a trusted root's.

The stages verify no issuer, press or log-entry signatures. The sub-card's holder and app signatures are the exception, but the host controls those keys in the attack below. For an ordinary verifier this is sound: step 1 comes from the chain through the verifier's own RPC. In the enclave, step 1 comes from the host (snapshots and per-card fetches), and host-supplied registry state is unverified in v1 (T8, L4).

### The attack

A hostile host:
1. generates its own keys for a master card M′, a sub-card S′ and an app card A′;
2. writes M′ with `policy_id` = the source policy, `ancestry_pubkeys = [P, R]` (a real policy card and a real trusted root), any field values it likes, and `active_subcards = [S′]`. It encrypts M′ under M′'s public-key-derived content key;
3. writes A′ with `ancestry_pubkeys = [<the pinned app-certification root>]`;
4. writes S′ holder-signed by M′ and app-signed by A′, with the `notary_input` capability, at level T2;
5. adds registry entries for M′ (under the snapshotted source policy), S′ and A′ to what it feeds the enclave.

Every check then passes:
- B5: the sub-card's signatures are by M′ and A′, keys the host owns.
- B6: the binding is self-consistent.
- B7: the walk reaches R by address; R is never fetched or signed.
- B8: the predicates read fields the host wrote.

The host can sign any number of inputs as M′₁, M′₂, … and **stuff an aggregation or a vote**.

### Why the obvious fix doesn't close it

Verifying `issuer_signature` at each hop doesn't help. That signature excludes `recipient_pubkey` (`protocol-objects.md §1`), so it doesn't bind a card to its holder's key: a genuine P-issued document can be re-keyed to M′. What binds a card to its key is `press_signature` plus the press's authorization. Both are on-chain registry state, so they are host-supplied again.

**Without verified chain reads, the enclave can't tell a registered card from a forged one.**

### Who is protected today

- **Contributors' privacy and consent: unaffected.** Wallets check the job and the policy with their own chain reads (algorithm W).
- **Notarization verifiers:** algorithm N checks the notary, attestations and commitments, but can't see who the counted contributors were.
- **Cross-operator replica sets:** an honest operator's enclave reads that operator's own feed, which doesn't contain M′. It refuses the forged inputs, so they never reach q acknowledgments, and close stalls on a mismatch. Forgery then needs a colluding quorum of operators, which T7 already assumes against.
- **Single-operator jobs:** unprotected. The spec allows them, and it's the default shape for aggregations.

### Options

| | Option | What it does | Cost |
|---|---|---|---|
| **B1** | **Cross-operator quorum required** (recommended for v1) | A job's `replica_set` must have, within every possible quorum of q replicas, at least one card whose `operator_card` differs from the others'. In practice: replicas from at least two operators, and no single operator holding q instances. The wallet (W7) and the enclave (step 17) refuse other jobs. A forged contributor then needs colluding operators (T7). | Every job needs two operators, so single-operator notaries can't serve jobs where counts matter. Communities need at least two operators. |
| **B2** | **Verified chain reads** | The enclave verifies registry state itself: Arbitrum state proofs against an L1-anchored header, with finality. This is already listed as P2 in `card_protocol_spec.md §9`. | Large; research-grade for v1 (L3 today: headers are only hash-linked). |
| **B3** | **Disclose and allow** | Keep single-operator jobs. Restate L4 honestly ("a single-operator host can add forged contributors"), and have the consent screen and notarization show "single operator: counts depend on the operator's honesty". | No engineering cost, but much weaker G1 objectives for single-operator jobs. |

**Recommendation:** **B1 now, B3's disclosure wording in the threat model, and B2 kept as the P2 path.**
- Derived cards also need B1. Otherwise a single host can mint derived cards for forged source cards, and verifiers would accept them, because algorithm G checks the notary, not the source.
- B1 is a spec change: lifecycle W7 / step 17, `protocol-objects.md §21` `replica_set`, the threat model T7 and L4, and §9's P0 replication bullet. It touches **CP3-approved spec text**, which is why it needs your decision.

---

## Part A: the read paths (E31)

Proposed whatever Part B decides. Under B1 these reads are trustworthy to the extent at least one honest operator's feed is.

### A1. The policy at `policy_state_cid` (W3, W4, W10)

What the specs already fix:
- a policy is a card whose `policy_id` points at a snapshot CID that the verifier reads as plain JSON (`card_verifier.md` §7.5 step 1);
- a job signs `policy_id` (genesis) and `policy_state_cid` (the head when signed);
- wallets check both with their own chain reads (W3, W4).

**Proposal** (algorithm R, new lifecycle Appendix A.7):
1. Fetch the documents at `policy_id` and `policy_state_cid` by CID (`fetch ipfs:`), checked against their CIDs. Content addressing makes these authentic whatever the host is. **Format:** accept a plain-JSON document, or one encrypted under the policy key (`HKDF-SHA3-256(recipient_pubkey)`), reading `recipient_pubkey` from the genesis document. Today's press pins plain JSON (and records `keccak256(policy CID)` as the policy address, code-plan F13), so both forms occur.
2. **W4:** the policy's registry history (`card_head:`, E30 shape) contains `policy_state_cid`, and the `notary` section and `approved_notaries` at the current head equal those at `policy_state_cid`. Otherwise `JOB_POLICY_CHANGED`. The current head is decrypted like any head (`decryptCardHead`).
3. **W3:** the policy card's chain reaches a pinned trusted root and isn't revoked: Stages 3 and 4, exactly as for contributors. Otherwise `JOB_POLICY_UNTRUSTED`.
4. **W10:** each `replica_set` card is in `approved_notaries` at the current head.

The TypeScript twin goes in `verifier/src/notary/policy.ts` and implements the wallet's `NotaryChainReads.policyAtState` over the same world. The conformance generator gains policy cases, and Rust must agree, as for B5–B8.

### A2. The job requester's chain (W5)

Only when `job_requester_predicate` is present.
1. Read `requester_card`'s head by registry entry (`card_head:`). Decrypt it with `HKDF-SHA3-256(requester_pubkey)`; the binding `keccak256(requester_pubkey) == requester_card` is already checked in W2.
2. Run Stages 3 and 4 on it, then the predicate. `is_holder` is true iff `requester_card` is the policy card's holder address (`keccak256` of the policy's `recipient_pubkey`), matching §2.1's "`{ is_holder: true }` means only the policy holder".
3. The requester's card is outside the snapshotted policies, so this uses the disclosed per-card fallback. That reveals nothing: the job is public.

Same twin-and-vectors treatment as A1.

### A3. Governance list histories (algorithm L input)

- **Pins:** the image pins each list card's **public key** as well as its address (one more field per list in the runtime §12 pins). The key gives the content key; the address is checked as `keccak256(key)`.
- **History:** read from the list card's registry events (`card_head:` → `events`). Each version's state is `decryptCardHead` of that event's CID. The `ListVersion` is that state's list field plus `list_approval`.
- **Trust:** comes from the **member signatures** (algorithm L), not from registry state. A host that omits or reorders versions breaks L's `prev_list_hash` and `list_version` continuity checks. A host that withholds the newest version is limit L5 (unchanged). So A3 is unaffected by Part B.
- **Reading all versions is acceptable,** because lists change rarely.

### A4. Spec edits Part A needs

All are one-paragraph clarifications of existing intent:
- `notary_lifecycle.md`: a new Appendix A.7 (algorithm R), with step 17 and W3/W4/W5 pointing to it.
- `notary_runtime.md` §12: the list read path and list-card public-key pins. §9: `create_job` reads the policy through `fetch` (E21).
- `notary_host.md` §8: the per-card fetch shapes (E30).
- `card_protocol_spec.md` §9: none for Part A.

---

## Decisions for David

1. **Part B: decided, B3** (David, 2026-11-12). Single-operator jobs stay allowed. The threat model restates the limit honestly, and the consent screen and notarization disclose that counts depend on a single operator's honesty. B2 (verified chain reads) stays P2.
2. **Part A: approved** (David, 2026-11-12), with no network connection from the enclave. All reads are `fetch` messages over vsock to the host.
3. **Who edits the spec text** once you decide: this session, under your approval of the exact wording.

Once 1 and 2 are answered, implementation follows the 5.3a pattern: TypeScript reference first, vectors, Rust port, oracle wiring. Then 5.5's end-to-end run can proceed.
