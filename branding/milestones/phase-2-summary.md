# Phase 2 Milestone Review — Brand and Message

*2026-08-16. Reviewed: `assurances.md`, `brand-guide.md`, `messaging.md`, `capability-status.md`, `audiences.md`, `strategic-plan.md §Objectives`. Conducted inline.*

---

## Phase deliverable: met

All three Phase 2 outputs exist and have been through David's revision. The assurance register grew to eleven claims (A0–A10), within the 6–12 the strategic plan specified.

## Checks run

**Claim-to-assurance traceability.** Every assurance A0–A10 is referenced somewhere in `messaging.md`. Every pillar and supporting message cites at least one. **One deliberate exception:** the impact-data sentence in the positioning statement and supporting messages has no assurance behind it, because the notary service isn't in MVP scope. It's retained as a demand test — documented in `brand-guide.md §Positioning` and flagged in `messaging.md`. This is a known, recorded exception rather than drift, but it is the one place where the traceability rule is knowingly broken and it should stay visible.

**Blockchain vocabulary leak.** Clean. The only occurrences of blockchain/Web3/on-chain/token vocabulary across `messaging.md` and `brand-guide.md` are inside the rules prohibiting them. No organizer-facing copy contains any.

**Overclaiming against pre-launch state.** Clean. The honest statement is placed before the CTA rather than after. No "get started" or "try it now" language. The assurance register carries its own method statement distinguishing design guarantees from verified claims.

**Voice consistency.** The brand guide's voice principles and the drafted copy in `messaging.md` are in the same register — checked specifically because a guide and its first application usually diverge. Two corrections during the phase both moved in the same direction: cutting a constructed-sounding line ("your group chat can hold a conversation, it can't hold any of these") and replacing a form question that read as marketing-clever rather than useful. **Voice principle 6 — "warm, not folksy" — is doing real work and the drafts are being held to it.**

**Cross-document consistency.** CTA constituencies in `messaging.md` match the secondary CTAs in `audiences.md` (organizers, security, builders — funders excluded by decision). Component naming is consistent. The `brand-guide.md` CTA section now points to `messaging.md` rather than duplicating it.

## Changes made during the phase

| Change | Reason |
|---|---|
| Pillar 1 reworded from "build things for itself" to "create shared resources anywhere" | "Build" reads as an invitation to code — intimidating for the target audience |
| New pillar 2: showing others your community is worth trusting | The outward-facing half of the value; also the natural bridge to professional networks |
| Decentralization demoted from pillar to supporting message | A property, not a value proposition — nobody adopts because something is federated |
| Privacy moved into pillar 2 rather than demoted with federation | A benefit, not a property; it's the mechanism that makes showing a card cost nothing |
| Switching cost moved from pillar 2 to pillar 3 | Page now runs value → value → and it costs almost nothing, ending on ease |
| Discovery question moved from form to first conversation | Takes real thought; would cost submissions and yield shallow answers |
| Funders removed from CTA; app builders added | Funders are contacted directly; builders are what makes a first pilot possible |

## Open items

**All four resolved 2026-08-16:**

1. **"Places" vs "shared resources" — keep both.** Two angles triangulate better than one repeated phrase; "places" carries somewhere-you-go, "shared resources" carries something-you-use. Neither carries the meaning alone — the examples do.
2. **The low-commitment tier — removed, not added.** There is one form and it is not an application. It reads as *learn more and be invited into a conversation*. Qualifying happens in the conversation, by a human, which is where the concierge model does it anyway.
3. **A8 — fixed by shifting the subject.** Plain now reads *"no single one of them can see what cards you hold"* — absolute and accurate simultaneously, because the split-knowledge design is the guarantee. The technical rendering states the collusion threshold as a strength rather than a caveat: reconstructing who received what would require a wallet service and multiple independent relays to conspire against a specific person.
4. **A9 — governance stated accurately from day one.** Board "chosen by active participants," no implied transition, plus an explicit limit: the board doesn't run infrastructure, hold data, or decide who may operate a service. *The less the board can do, the less it matters who sits on it.*

**Carried from Phase 1, unchanged:**

5. Revocation implementation gap — must close before pilots, not before the site. See `capability-status.md`.
6. ML-KEM implementation verification and the wallet-service inference question — both good recruiting material for the security bench.

## One observation for Phase 3

The pillar order now assumes the reader's switching-cost worry can wait until pillar 3. That's a reasonable bet and it gives the page a better shape, but it's the structural assumption most worth testing in wireframes. If readers stall at pillar 1, a single line there defuses it without spending the pillar.

## Recommendation

**Proceed to Phase 3.** The wireframes have unusually clear inputs: three pillars in order, a reader journey with eight stages, a three-destination site structure, and a form spec. The main open design question — whether the landing page needs internal sub-pages or disclosure sections — is exactly what 3.1 exists to answer.
