# Phase 1 Milestone Review — Discovery

*2026-08-16. Reviewed: `capability-status.md`, `research/interview-guide-audiences.md`, `research/interview-audiences.md`, `audiences.md`, `reference-sites.md`, `strategic-plan.md §Goals`. Conducted inline rather than by fresh-context subagent.*

---

## Phase deliverable: met

All four Phase 1 outputs exist. Discovery produced more than expected — chiefly because two pre-existing assets (the Substack post and Rhizal) turned out to be more directly usable than anything the phase would have generated from scratch.

## Consistency check

**Do audience hero capabilities exist in the capability inventory?** Yes, with one caveat. The primary audience's hero capability is gated shared resources — Matrix rooms and member-built tools — which `capability-status.md` rates *Partial: join-time gating works, ongoing enforcement does not.* Adequate for a pre-launch site making design-guarantee claims. **Not adequate for a live pilot**, and Phase 3 (frontend, partner testing) should not begin until the revocation watcher is actually started. Flagged, not blocking.

**Were reference sites chosen on evidence or taste?** Rescoped mid-phase on evidence — the Q28/Q30 finding that technology cannot be the protagonist invalidated the original protocol-site scoping. The final set is drawn from the movement/organizing space with a deliberate commercial counter-example. Rhizal was surfaced from Relationality Lab's own site rather than assumed.

**Did discovery invalidate any strategic goal?** Three, all now corrected in place:

| Was | Now |
|---|---|
| Goal 3: "converts organizers into pilot participants," volume-oriented | Concierge model, ~5 excellent fits, discovery question as hook |
| Goal 4: cold outreach through a personal network | Ecosystem activation across a named movement with warm ties throughout |
| Goals 2/2b: per-assurance build-status labels on the site | Assurances stated as design guarantees and tested against; build state stays internal |

Also corrected: Goal 2's "3–5 audience segments" narrowed to one primary audience.

## The five governing findings

1. **A card is worthless without a paired service.** Its value is access, so every rollout needs something worth accessing. What that should be is the central unknown and the site's main job to discover.
2. **Technology cannot be the protagonist.** The precise objection is *technocolonialism*, not technology — resemble Signal, avoid resembling billionaire-led giants. Values come through structurally rather than being centered.
3. **Communities add, they don't switch.** Nobody leaves WhatsApp. Cards are adopted for what WhatsApp can't do. Much lower bar than migration.
4. **The organizer is the buyer; the member is the user.** Two-sided adoption. The site owes organizers something they can paste into a group chat.
5. **This is an organizing play, not a product launch.** Relational, not SaaS. Governs voice, CTA design, and the promotion plan.

## Assets discovered that reshape later phases

- **The Substack post** ("Let's Create A Living Wage…") supplies the Desiree narrative, the value→data→legibility→expansion frame, the sushi anti-consolidation argument, and "technology that is humble and rooted in the communities it serves." It is the single most useful source document in the project.
- **Rhizal** is a working solution to the identical structural problem — pre-launch, alpha, invitation-only, open source, honest about incomplete security, two-stage qualifying form. Adopted as the structural template, and a candidate volunteer-onboarding channel.
- **Relationality Lab as parent** resolves the personal-brand question and supplies credibility, house style, and an existing relational-impact-reporting practice that the data-donation feature productizes.
- **The movement ecosystem** is a warm, pre-written Phase 5 target list.

## Gaps that could trip Phase 2

1. **The assurance register is the hardest writing in the project** and carries four known flags: the ML-DSA-44/ML-KEM wording error, the absent forward secrecy, revocation as the weakest claim against current code, and the global "servers cannot track you" claim. All are recorded in `capability-status.md`. Step 2.1 needs real time.
2. **The multi-page question is unresolved.** There's more conceptual territory than Rhizal's single scroll holds, but the structure isn't decided. Belongs in wireframes (3.1), not brand guide (2.2) — noting it here so it doesn't get lost.
3. **No named example service exists yet.** The site needs a menu of hypotheticals, clearly labelled. Drafting them is a Phase 2/4 copy task with no owner assigned.
4. **The demo question is open.** David can create a card but it does nothing; a basic hold-and-message UI was floated but the site is explicitly not gated on it. Affects the hero section — flag for 3.1.

## Still outstanding

- **Q19** — whether the site should generate inbound for paid implementations. *Answered: opportunistic, no services path needed. Revisit if it changes.*
- **Q12** — size and engagement of the Relationality list. **Needed for Phase 5, not Phase 2.**
- **Rhizal visual proximity** — resolved: Rhizal structure, `color_palette.md` colour, "a project of Relationality Lab" above the header.

## Recommendation

**Proceed to Phase 2.** Start with 2.1 (assurance register) as planned — it's the longest pole and the brand guide's terminology section depends on its vocabulary. Budget more time for it than the plan implies, and expect the security-advisor recruitment to begin during it rather than after.
