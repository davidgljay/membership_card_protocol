# Off-Chain Registry Migration — Design Spec

**Version:** 0.1 (draft)
**Date:** 2026-09-07
**Status:** Draft — pre-implementation, exploratory

**Relationship to existing specs:** This spec assumes the current Arbitrum One registry contract (`object_specs/registry_contract.md`) as the system of record for the foreseeable future. It defines (a) the target-state design for a press-operated gossip network that could eventually replace the registry's authoritative role, and (b) the migration path from one to the other, so that today's registry contract can be built without foreclosing this option. Nothing in this spec requires code changes now. It is a design reference for a future ADR, not itself an ADR.

---

## 1. Why this exists

The registry contract's real job isn't storage — cards and their content already live on IPFS, and per-card logs are already self-verifying hash chains. The contract's unique job is preventing **equivocation**: guaranteeing that every verifier sees the same current head/revocation state for a given card, so a compromised or dishonest press can't show different verifiers different, conflicting truths.

A blockchain solves equivocation by giving up something in exchange: a small, real, permanent cost per write, and a governance process bottlenecked by proxy-upgrade timelocks for anything that needs to change quickly. Early in the protocol's life, when governance rules are still being iterated on frequently, that's a reasonable price. It may not always be — as press count grows, or as the protocol's philosophical commitment to decentralization argues against a single chain as the permanent root of trust, it's worth already knowing what "off-chain" looks like and what it costs to get there.

This spec is the answer to "is this sane," made concrete enough to build later without redesigning it from scratch.

---

## 2. Goals and non-goals

**Goals:**
- Preserve the guarantee verifiers currently get from the registry contract — a consistent, tamper-evident answer to "what's the current state of this card" — without requiring a blockchain write per update.
- Make equivocation *provable* rather than *prevented* in real time, and make that proof cheap to produce and impossible to fake.
- Keep the migration itself boring: a planned, governance-triggered cutover with a verifiable checkpoint, not a rewrite of the card/log data model.
- Keep card logs gossip-compatible from day one, regardless of when (or whether) the gossip network is actually built.

**Non-goals (for this version of the spec):**
- This is not a proposal to migrate now. Per the discussion that produced this doc, the trigger is a governance decision, not a default timeline.
- This does not replace the registry contract's role in press authorization, policy registration, or DNS resolution — only its role as the authoritative pointer/revocation store for card heads.
- This does not specify a cryptoeconomic staking/slashing system. Given presses are governance-authorized, not permissionless entrants, a lighter reputation model is proposed instead (§4). Staking is noted as a fallback if the lighter model proves insufficient.

---

## 3. Target-state architecture

### 3.1 What moves off-chain

The registry contract's `CardEntry` head-pointer and revocation state (`object_specs/registry_contract.md` §3.1) move to a press-gossiped, hash-chained structure. Press authorization, policy registration, and DNS resolution stay on-chain — these change rarely and benefit from the contract's existing governance-quorum machinery (§9 below explains why).

### 3.2 Every press gossips with every press

Per the decision to have full-mesh participation rather than a smaller witness set: every authorized press periodically exchanges its current view of card head/revocation roots with every other press it knows about. This is the simplest topology and matches the protocol's existing peer-list pattern already used for wallet-service migration broadcast (`process_specs/card_migration.md` §4) and message routing — presses already maintain peer lists and broadcast to them.

Full mesh is fine at current and near-term scale (tens to low hundreds of presses). If press count grows into the thousands, this becomes a later optimization problem (e.g., gossip fan-out limits, not a redesign), not a blocker now.

### 3.3 Gossip payload

Each gossip round, a press publishes a signed statement:

```json
{
  "press_id": "<press card address>",
  "round_id": "<monotonic counter or timestamp>",
  "card_roots": [
    { "card_address": "<...>", "head_cid": "<...>", "revoked": false, "as_of": "<ISO 8601>" },
    ...
  ],
  "signature": "<press secp256r1 signature over the above>"
}
```

This is the direct off-chain analog of `UpdateCardHead` (§4.2 of the registry contract spec) — same data, different substrate. Receiving presses store the signed statement as-is; the signature is what makes it self-verifying without needing the sender to be trusted.

### 3.4 What a verifier does

Two-tier check, per the discussion in §7 below:

1. **Ask the issuing press directly** for the card's current state (fast, single hop, source of truth for that card — the issuing press is also almost always where updates originate).
2. **Cross-check against the gossip network's converged view** (any press, since all presses gossip) as a backstop against a compromised, down, or lying issuing press.

Both checks should resolve in the same request/response window a client already tolerates today (target: low single-digit seconds for step 1, informed by gossip state that's at most minutes stale for step 2 — see §7).

---

## 4. Press trust and reputation over time

The question raised: when a new press disagrees with an established one, should that be weighted differently than two long-standing presses disagreeing?

**Proposal: tenure-based trust tiers, not stake.** This mirrors how Certificate Transparency log operators handle new logs — a new log starts in a "pending" state and only becomes fully trusted after a qualification period of clean operation, monitored by the ecosystem. Applied here:

- A newly-authorized press starts at trust tier **Provisional**: its gossip statements are stored and propagated normally, but weighted lowest in any tie-breaking or triage logic.
- After a governance-defined period of clean gossip participation (no proven equivocation, consistent round participation) — e.g., 90 days — a press advances to **Established**.
- Trust tier is a *triage and default-display* signal, never a correctness override. A Provisional press's cryptographically valid signature is exactly as valid as an Established press's. What tier affects is: which side of a genuine disagreement gets investigated first, and what a verifier's client UI defaults to showing when it can't yet resolve a conflict on its own.

**Why not stake/bonding:** presses are already governance-authorized actors, not anonymous permissionless nodes — the Sybil-resistance problem that staking solves for public blockchains is already handled by `PressAuthorizations` (registry contract §3.3) and `AuthorizePress`/`RevokePress`. Adding a bonding requirement on top would add cost and complexity without buying much additional security at current scale. Flagged as a fallback if tenure-based tiering proves too weak in practice — e.g., if a malicious actor can get authorized, wait out the qualification period, and then equivocate. That specific attack is bounded by how hard it is to get authorized as a press in the first place, which is a governance question, not a gossip-protocol one.

---

## 5. Fork detection and adjudication

The key move here — and the answer to "how do you keep the governance layer from being spammable" — is to **separate detection from consequence.**

### 5.1 Detection is cryptographic, not reported

An equivocation is provable by construction: it's two signed statements from the *same* press key asserting two different, mutually exclusive head roots for the same card (or contradictory revocation states) at overlapping validity windows. Any press or client that receives both statements — through normal gossip, no special reporting mechanism needed — can verify the proof itself in code, with no human or governance step involved. This is the same principle Certificate Transparency relies on: a fork isn't an accusation, it's a piece of math either valid or not.

This is what solves your spam concern: **nothing reaches the governance process without a valid, unforgeable proof already attached.** There's no way to "report" a press maliciously, because a report is either a valid cryptographic proof (rare, and real) or it's rejected by software before a human ever sees it. You can't DoS a governance body with something that requires a genuine key compromise or protocol violation to produce.

### 5.2 What governance actually decides

Once a valid proof exists, the hard part isn't "who's lying" — the proof usually makes that unambiguous (whoever signed both sides). The hard part is **what happens next**, which is a policy question, not a cryptographic one:

- Suspend the press's authorization pending investigation (`RevokePress`, already an existing governance-gated operation).
- Determine which of the press's card entries are affected and need holder notification.
- Decide whether the equivocation implies key compromise (requiring rotation, per the protocol's existing key-rotation model) versus a bug or operational error.

This decision, once made, is itself published as a signed governance statement into the same gossip network — the same versioned-adoption pattern already used for other protocol rule changes (e.g., `RotateOnChainKeyScheme`'s phased rollout in the architecture doc). Presses and client software apply it going forward; it doesn't retroactively resolve the ambiguity for whatever window existed before detection.

### 5.3 Easy case vs. hard case

- **Easy case** (a new press immediately contradicts an established one): resolved almost entirely by §4's tiering — a fresh Provisional press disagreeing with a long-established one on day one is exactly the scenario the qualification period exists to de-risk, and it's very likely a Provisional-press bug or misconfiguration rather than a deep protocol problem.
- **Hard case** (an established press equivocates subtly — e.g., shows a stale/fraudulent state only to a subset of verifiers or peers): this is caught only as fast as gossip coverage allows. This is the honest limitation of the whole approach, and it's worth naming directly: real-world CT deployments designed a client-side "gossip" mechanism for exactly this and largely never got it running at scale in practice — the ecosystem instead leaned on requiring multiple independent, cross-auditing logs rather than peer gossip to catch subtle splits. The practical mitigation here is full-mesh gossip (already the chosen topology) plus keeping the gossip interval tight enough that a subtle fork can't persist long before some press's independent check surfaces it.

---

## 6. Migration mechanics

Per the decision that migration is governance-triggered and handled like any other logic update: this maps directly onto the registry contract's existing `UpgradeLogic` mechanism (`object_specs/registry_contract.md` §4.14, §6.3), which already implements a 7-day timelock via `RootPolicyBody` quorum. The full-network migration is the largest possible instance of that same mechanism, not a new one.

**Sequence:**

1. **Governance proposes migration**, with a target cutover block height/timestamp at least the standard timelock window out (7 days minimum, likely longer given the stakes — this is a parameter, not fixed by this spec).
2. **Announcement propagates** to all presses and, ideally, to client/verifier software, the same way any other protocol version bump does.
3. **At the cutover point**, the registry contract's card-head/revocation write paths (`UpdateCardHead`, revocation operations) are permanently disabled via the logic upgrade. Press authorization, policy registration, and DNS resolution can remain on-chain indefinitely — this migration is scoped to the head/revocation registry role only (§3.1).
4. **Final on-chain state is the checkpoint.** Every card's final on-chain head CID and revocation state, at the cutover block, is read and hashed; that hash is itself published on-chain (a cheap final write) as the canonical genesis root for the gossip network. Any press or client can independently recompute this hash from the chain and confirm the gossip network's starting state matches it — the migration doesn't require trusting whoever performed the copy.
5. **The contract becomes a permanent redirect stub.** Read calls against the old head/revocation storage return a pointer to the gossip network (a "this registry has moved, verify via the gossip network as of checkpoint block N" response) rather than being torn down. This costs almost nothing to keep alive indefinitely and gives old clients/integrations a hard, unambiguous signal rather than a silent failure.
6. **Gossip network takes sole responsibility going forward**, per your answer to §4 of the original discussion — there's no dual-write or dual-trust period after cutover. Anything issued or updated before the checkpoint is anchored by the frozen on-chain state; anything after is gossip-native from the start.

---

## 7. Revocation freshness and the harm window

This is the part with real-world stakes, and your proposed design is sound: **check the issuing press first, treat the gossip network as the backstop**, with both resolving on the order of minutes at worst.

Reasoning for why this bounds harm acceptably:

- The issuing press is (almost always) where a revocation originates, so the common case — verifier asks issuing press, gets the current answer — has effectively no propagation delay at all. The "minutes" window only matters for the uncommon case: the issuing press is down, compromised, or (in the fork scenario) lying.
- In that uncommon case, the gossip network's converged view is the fallback, and its staleness is bounded by the gossip interval you choose. "Minutes" as a target interval is reasonable and matches Certificate Transparency's own precedent — production CT logs commit new entries into signed tree heads roughly every few minutes to an hour depending on the log, and browsers treat "recent enough" the same way you're describing.

**One alternative worth flagging as an open question rather than deciding now:** instead of (or alongside) propagating *revocations*, presses could periodically re-issue short-lived positive "still valid as of T" attestations for unrevoked cards — closer to the direction TLS is itself moving (short-lived certificates replacing OCSP) than to a traditional revocation list. This sidesteps "how fast does bad news travel" entirely, at the cost of needing "how fast does good news expire" tuned instead. Worth a follow-up spec once there's a clearer sense of real verification-latency requirements from actual use cases — not something to decide today.

---

## 8. Log format requirements (buildable now, regardless of timeline)

Independent of when or whether the gossip network gets built, the per-card log format should already satisfy these properties so migration is a checkpoint-and-fork (§6) rather than a data-model rework:

- Each log entry is self-contained and independently verifiable (signature + hash-link to the prior entry), never requiring the on-chain contract to interpret content — this is already true of the linked-CID-chain design.
- The on-chain contract's role is reducible, cleanly, to "which CID is current" and "is this revoked" — no logic should creep in that only the contract can evaluate, or migration inherits that logic as a dependency.
- Press signatures on gossip-shaped statements (§3.3) use the same secp256r1 on-chain scheme already in use for `UpdateCardHead`, so a press's existing operational key material carries over unchanged — no new key ceremony required to participate in gossip when it's turned on.

---

## 9. Open questions

- **Governance body for fork consequences.** Is this the same `RootPolicyBody`/governance quorum already defined for contract upgrades, or a distinct body scoped specifically to press conduct? The proof-gating in §5.1 bounds spam regardless of which body handles it, but the two may want different quorum/timelock parameters (fork response plausibly needs to be faster than a 7-day contract upgrade timelock).
- **Gossip interval and fan-out limits at scale.** Full mesh (§3.2) is fine now; the threshold at which it needs revisiting, and what replaces it, isn't specified here.
- **Freshness-attestation alternative (§7).** Worth a dedicated spec once real usage patterns exist.
- **Provisional-period length and advancement criteria (§4).** 90 days is a placeholder; should probably be a governance-tunable parameter rather than fixed in this spec.
- **Does DNS/domain-admin card logic (`registry_contract.md` §3.8–3.11) ever need to move off-chain**, or does it stay on-chain permanently alongside press authorization? This spec assumes the latter but doesn't argue for it strongly.

---

## 10. Security Considerations: Compromised-Press Risk Comparison

This section walks through what changes, security-wise, when a press's misbehavior is no longer checked by the registry contract but by the gossip network instead. The short version: a compromised press gains no new *forgery* power, but it gains meaningfully more room to lie by omission, and the network's ability to detect and bound that is weaker and slower than what the contract gives for free.

### 10.1 No new forgery capability

Signature verification is identical in both models. A compromised press still cannot produce a validly-signed update for a card it doesn't control, cannot forge another press's signature, and cannot claim assignment authority it was never granted. Nothing about moving off-chain weakens this — it's worth stating plainly since it's the part most likely to get lost in a list of new risks.

### 10.2 Commission vs. omission: the real gap

Distributed-systems security draws a standard distinction between a dishonest actor lying by **commission** (asserting something false and provable, like two contradictory signed statements) and lying by **omission** (simply not telling someone something true). §5's fork-detection model handles commission well — an equivocation is a mathematically provable object, cheap to verify, impossible to fake. It does nothing for omission.

A compromised press can sign a real, valid update, hand it to one targeted verifier who asks it directly, and simply never gossip it to any peer. There are no two contradictory statements for anyone to catch — just silence. The only available check is asking a second press "do you have this yet," which is a time-bound, sample-limited heuristic, not a proof: a negative result could mean malicious withholding, ordinary gossip lag, or an offline peer, and there's no way to distinguish these from the outside. This is the one place the off-chain design is structurally weaker than the contract, not merely different from it — on-chain, "did this update happen" has one authoritative answer the instant it's mined; off-chain, it's an eventual, distributed fact that no single check can settle with certainty.

**Mitigation — N-of-M propagation confirmation.** Rather than treating a single peer check as sufficient, require confirmation from N of a randomly-selected M presses (M drawn broadly enough to make collusion expensive, N large enough that losing a few to network lag doesn't produce false alarms) before a card-affecting operation — revocation above all — is treated as "complete" and safe to rely on. This converts an unfalsifiable single-sample heuristic into a probabilistic guarantee whose confidence is a tunable parameter (larger N/M costs more round-trips but shrinks the chance a colluding minority can hide the update from the check). It should also run on a delay calibrated to the gossip interval (§3.2), since checking before at least one full gossip round has elapsed produces false positives regardless of honesty.

This doesn't make omission provable the way equivocation is — a press can still get unlucky-looking gaps past an N-of-M check with the right timing — but it bounds the *cost* of getting away with it and gives operators a concrete, tunable dial rather than an all-or-nothing trust assumption.

### 10.3 Eclipse attacks on verifier sampling

A verifier that checks "any press" per §3.4 for its gossip-network backstop is only as honest as the presses it happens to sample. If a verifier's sampling strategy is naive (e.g., always asks the same press, or asks presses from a list an attacker can predict or influence), a small set of colluding or compromised presses can present a consistent, self-reinforcing lie to that verifier indefinitely — the peer-to-peer analog of the eclipse attacks known from Bitcoin/Ethereum networking.

**Mitigation.** Verifier-side sampling should be randomized and diversified per check (not a fixed peer list), and should draw across trust tiers (§4) rather than defaulting to convenience — e.g., don't let a verifier's "gossip backstop" collapse into always asking the same one or two presses it happens to have a connection open with. Full mesh among presses themselves (§3.2) already reduces the attack surface for press-to-press gossip, since it's hard to isolate a press that maintains direct connections to every other press; the residual risk is specifically in how *verifiers* (not presses) choose who to ask.

### 10.4 Weaker, quieter availability floor

Arbitrum's uptime is a strong, externally-operated, externally-audited guarantee that this protocol gets for free. Gossip network availability instead depends on however many community-run press nodes are actually online and reachable at any given moment, and unlike a chain halt (loud, immediately visible to everyone), degraded gossip coverage is silent — the freshness target in §7 can slip from minutes to hours with no equivalent of a chain-halt alarm unless one is explicitly built.

**Mitigation.** Treat gossip-network staleness as a first-class monitored signal, not an assumption: presses (or a lightweight independent monitor) should track and publish how recently they've successfully exchanged state with peers, so a verifier — or a human operator — can distinguish "the network is healthy and this is genuinely current" from "coverage has degraded and this answer is stale in a way nobody has surfaced yet."

### 10.5 Replay of stale-but-validly-signed statements

The registry contract gives global, unambiguous ordering for free via block height and nonces — an old on-chain state literally cannot be replayed as current. Gossip has no built-in referee for this: a compromised press, or even just a network partition, could rebroadcast an old, legitimately-signed "still valid" statement to peers that haven't yet seen a newer revocation, and without explicit protection those peers would have no reason to prefer the newer one.

**Mitigation.** Every gossip-receiving press and verifier must enforce simple monotonicity: reject or deprioritize any signed statement whose `round_id`/timestamp (§3.3) is older than the latest one already held for that press and card. This is a small implementation requirement, but it needs to be a hard rule, not an assumption — the contract enforced this implicitly and the gossip network has to enforce it explicitly.

### 10.6 Wider compromise blast radius

A forged or misused on-chain write is visible to 100% of observers the instant it's mined. A compromised press's off-chain signing key can misbehave against a subset of the network for as long as gossip coverage takes to catch it — meaning the *exposure window* of a key compromise scales with the gossip interval and coverage quality (§3.2, §5.3), not with "one block" the way it does on-chain. This is a direct consequence of trading real-time global consistency for after-the-fact provability (the trade-off named back in §1), not a new flaw introduced by this section — but it's worth stating in absolute terms: the same key compromise is more dangerous, for longer, in the gossip model than in the contract model.

### 10.7 Not a new risk, for contrast

A press refusing to ever *issue* a revocation in the first place — as opposed to issuing one and withholding it from gossip — is an equal risk in both models. Neither the contract nor the gossip network can force a press to submit a write it doesn't want to submit; that failure mode is a governance/authorization problem (bounded by `RevokePress` and related governance operations), not something either substrate solves on its own.

### 10.8 Summary

| Risk | Contract model | Gossip model | Mitigation here |
|---|---|---|---|
| Forged/unauthorized update | Not possible (signature-gated) | Not possible (signature-gated) | — (no new risk) |
| Provable equivocation | Not possible (single global state) | Possible, but provable and cheap to catch | §5 detection + governance response |
| Selective withholding (omission) | Not possible (writes are globally visible) | Possible, and not provable, only inferable | N-of-M propagation confirmation (§10.2) |
| Verifier eclipse | N/A (verifier reads one canonical chain) | Possible if sampling is naive | Randomized, tier-diverse verifier sampling (§10.3) |
| Availability degradation | Strong, externally audited floor | Weaker, and silent unless monitored | Explicit staleness/coverage monitoring (§10.4) |
| Stale-state replay | Not possible (chain ordering) | Possible without explicit protection | Enforced monotonicity on `round_id` (§10.5) |
| Compromise exposure window | ~One block | Scales with gossip interval/coverage | Tight gossip interval; N-of-M for high-stakes ops |
| Press refuses to issue revocation | Possible | Possible (no change) | Governance/authorization, not a substrate fix |
