# Membership Card Protocol — Marketing & Branding Strategic Plan

*Created 2026-08-10. Companion document: [implementation-plan.md](./implementation-plan.md)*

---

## Context

The protocol is technically well advanced (Arbitrum One registry, IPFS storage, press/wallet/verifier components, SDKs in progress) but its public-facing identity is not. Three names appear across existing material — "Membership Card Protocol" (README), "Mark Protocol" (`card_design_guide.md`), "Digital Neighborhood Protocol" (`technical_overview.md`) — and the existing `landing_page/` Jekyll site predates the current architecture. The strongest existing asset is `dnp_overview.md`: a narrative (Taryn, Fatima, the fitness program) that explains the protocol without a single word of cryptography. That narrative instinct, not the technical documentation, is the seed of the brand.

Per intake: existing `branding/` and `landing_page/` material is treated as **legacy reference only**. New brand guide and new site are written fresh. The canonical name is **Membership Card Protocol**. The primary conversion is **pilot-interest signups** — an early-access list, not an activation, because nothing is usable yet (see Constraint below).

### The honest-state constraint

**Nothing works for an outside community today.** The near-term capability set is: create and distribute cards; build applications that verify cards; message cards; run Matrix multiparty chats gated by card ownership; and — with sufficient trust — operate a press, relay, or wallet service.

This is the single most important constraint on the whole campaign. It means the site cannot say "get started" and the outreach cannot say "try it." Everything must be framed in the future-but-specific register: *this is what it will do, here is exactly where it stands, put your name down and I'll tell you when it's real.* Getting this tone right — concrete and confident without overclaiming — is harder than writing launch copy and is the main creative challenge of the project. The upside is that being unusually straight about pre-launch status is itself differentiating in a space full of vaporware.

---

### Where this sits in the project (added 2026-08-15)

| Step | Work | Status |
|---|---|---|
| 1 | Backend protocol + SDKs — confirm technical feasibility, enable fast movement if interest materializes | Substantially done (see `capability-status.md`) |
| 2 | **Marketing plan + interest-collection site** — recruit partners, learn real-world use cases | **This initiative** |
| 3 | Frontend for issuing/holding/verifying/messaging (web + React Native), tested with partners | Blocked on step 2 |

The consequence: **the landing page is a discovery instrument, not just a waitlist.** The backend is deliberately flexible; the frontend deliberately isn't being built until real user profiles and feedback exist. Step 2's job is to produce those relationships. So the site's success measure is not signup count — it is the number of partner conversations that teach David something he didn't know about how communities would actually use cards.

Two implications carried into the implementation plan:
- Alongside the low-commitment email CTA (Decision 4), there should be a **higher-intent secondary CTA** for people willing to describe their community and talk. These are the design partners for step 3.
- The audience profiles produced in Phase 1 are a **hypothesis to be tested by the site**, not a settled finding. Phase 5 outreach should be designed to generate corrective information, and the plan should expect to revise `audiences.md` after the first wave.

---

## Goals

### 1. Establish a single, durable name and identity for the protocol

Right now a person encountering this project three different ways gets three different products. Everything downstream — the site, outreach, the SDK docs, the eventual press kit — compounds off this decision, and every week it stays open is a week of work that may need redoing. This is the gating decision for the entire initiative.

### 2. Articulate the protocol in the language of community organizers, not cryptographers

The people who will actually issue the first cards are running block clubs, congregations, mutual aid networks, and youth centers. They do not care about ML-DSA-44. They care about "who's actually in this group" and "how do I let people share things without building a website with logins." The brand's job is to make the protocol legible to that audience while remaining credible to the developers and funders who will evaluate it more skeptically.

### 2b. Publish a canonical register of assurances

A short, fixed list of promises the protocol makes — stated once, in plain language for organizers and in precise language for developers, as two renderings of the *same* numbered claims. This does three jobs at once: it gives non-technical readers something concrete to trust, it gives developers something specific to verify against the implementation, and it disciplines the marketing by making every headline claim traceable to a numbered assurance. It also becomes the natural bridge between the organizer-facing site and the technical docs — the same list, one toggle apart.

### 3. Ship a landing page that starts real conversations with club builders

A live, honest, well-built page is the artifact that makes every other conversation possible — it's what a link in a LinkedIn message or a Bluesky post points at. It must do one job well: get a club builder who has 90 seconds of attention to understand the idea, recognize themselves, and want to talk.

*Revised after Phase 1: a card is worthless without a paired service, so the first wave is concierge rather than self-serve. The target is roughly **five excellent fits**, not signup volume. The page should qualify hard and lead with the discovery question — "what would your community share if it were easy?" — which is simultaneously the value prompt, the qualifier, and the opening line of a real conversation.*

### 4. Activate the movement ecosystem David already belongs to

Cold-start network protocols do not bootstrap from advertising; they bootstrap from trusted introductions.

*Revised after Phase 1: this was originally scoped as cold outreach through a personal network. That was wrong. David has warm relationships across a named movement — BuildIRL, Aspen Weave, Foundation for Social Connection, Connective Tissue, the Interstitium, US Chamber of Connection, Relational Technology Project, Relational Design Lab, Donor Organizer Hub — plus a Substack, monthly Relationality Lab gatherings, and a book club network, all self-selected for this thesis. Phase 5 is **ecosystem activation**, not cold outreach.*

---

## Key Objectives

**Goal 1 — Name and identity**

- One canonical protocol name chosen, with a documented rationale and a decision on how (or whether) to name the wallet app, press, and verifier separately.
- `branding/brand-guide.md` exists covering name, one-line description, positioning statement, voice principles, terminology do/don't list, and visual direction.
- All new material written after the guide uses the canonical name; legacy files carry an explicit "superseded" header.

**Goal 2 — Audience-legible articulation**

- ~~3–5 named audience segments~~ **Revised:** one primary audience (club builders), with professional networks as a validation cohort and national/elite networks handled opportunistically offline. Narrowing beats hedging — copy written for two audiences at once goes generic and fails the recognition test.
- A messaging hierarchy: one headline, three supporting pillars, and message variants for the validation cohort.
- Every claim in the messaging traceable to a numbered assurance.

**Goal 2b — Assurance register**

- `branding/assurances.md` exists with 6–12 numbered assurances, each in both plain and technical rendering.
- **Assurances are stated as design guarantees and then tested against the implementation** — a security-claims methodology, valid conditional on the testing happening and its results being published. Presented as what the protocol is designed to guarantee and is being audited against, not as independently verified.
- **Build state is not itemized in high-level marketing.** Detailed status lives in `capability-status.md` for internal use and technical readers; it does not drive headline copy. *(Supersedes the earlier per-assurance build-status-label requirement.)*
- No headline, section header, or outreach message makes a claim that isn't backed by a numbered assurance.
- Developers can move from any plain-language assurance to the corresponding spec section in one click.

**Goal 3 — Landing page**

- A Jekyll site building cleanly and deployed to GitHub Pages on a real URL.
- Wireframes reviewed and approved by David before any build work starts.
- A working primary CTA that captures early-access interest and stores it somewhere David can actually retrieve it. The offer is explicit and modest: learn more, at most 1–2 emails a month.
- A developer path — toggle, secondary section, or linked page — presenting the same assurances in technically accurate language with links to the spec.
- Blockchain infrastructure is not front-of-house; cryptography *is* discussed openly as a privacy and security property.
- Page loads fast, passes WCAG 2.1 AA contrast, and reads well on a phone.

**Goal 4 — Network activation**

- A named target list segmented by constituency, with a warmth rating and a specific ask per person.
- Outreach templates for direct/personal, LinkedIn, and Bluesky — three genuinely different registers, not one message reformatted.
- A sequenced 6–8 week promotion calendar with an explicit definition of what "a successful first wave" means numerically.

---

## Decisions made (2026-08-10 intake)

| # | Decision |
|---|---|
| 1 | Canonical name: **Membership Card Protocol**. Legacy names (Mark Protocol, Digital Neighborhood Protocol) are superseded. Whether the wallet app gets its own consumer name is deferred to the brand guide. |
| 2 | Nothing is externally usable yet. Site and outreach use a pre-launch register; CTA is an early-access list. |
| 3 | Primary audience: people building community. Secondary: developers, served via a toggle/linked technical rendering of the assurance register. |
| 4 | Signup offer: learn more, 1–2 emails per month maximum. No further commitment implied. |
| 5 | Blockchain buried; cryptography discussed openly. "Cryptographically verified" is acceptable in non-technical copy; specific primitives named in technical copy. |
| 6 | Landing page lives in a separate `mcard_landing` repo, to be created and granted access by David. |
| 7 | Wireframes and mockups produced with Claude's visual tooling first (David wants to see how it operates); Canva available as a fallback for finished assets. |
| 8 | No deadline. Sequencing optimizes for quality over speed. |

## Remaining assumptions (flagged, not validated)

- David is the sole public face and primary outreach channel. No paid media budget assumed.
- The near-term capability list (issue cards, verify, message, Matrix-gated chat, self-hosted press/relay/wallet) is stable enough to write assurances against. If any item slips out of scope, the assurance register and every downstream claim need revisiting.
- Email capture can be handled by a static-site-compatible service (Buttondown, Listmonk, a form endpoint). Not yet chosen — resolved in Phase 4.
- The Canva connector is not currently authorized in this workspace. If Canva becomes necessary, it must be connected via claude.ai connector settings first.

---

## Open Questions (carried into implementation)

**A. Which capability anchors the headline?** All five near-term capabilities are compelling, but the Matrix-gated chat is the most immediately graspable ("a group chat only your neighbors can enter") while card issuance is the most foundational. The interview in Phase 1 should force a ranking rather than leaving all five equally weighted.

**B. How specific should the status labels be?** "Planned" is safe but vague; "shipping Q4" is compelling but creates an obligation. Decide the granularity before the assurance register is written, because retrofitting it means rewriting the site.

**C. Is there a demo?** Even a recorded video of a card being issued and verified on a test setup would transform the page from a promise into evidence. Worth knowing whether one is feasible before wireframing, since it changes the hero section.

**D. Does the assurance register live in the marketing repo or the protocol repo?** It's a marketing artifact and a technical one. Suggest it is authored in `card_protocol/branding/assurances.md` as the source of truth and rendered into the landing site, so it stays in sync with the spec.

---

## Skills and models — summary

Detailed per-step recommendations live in the implementation plan. The general shape:

| Kind of work | Model | Delegate? |
|---|---|---|
| Interviews, naming, positioning, synthesis | **Opus** | No — interactive, needs full context |
| Competitive/reference-site research | **Sonnet** | Yes — `Explore` or `general-purpose` subagent |
| Copy drafting, wireframes, Jekyll build | **Sonnet** | Partially — subagent per page section |
| Link checks, alt text, asset renaming, build verification | **Haiku** | Yes |
| Final review passes (accessibility, brand consistency, claim audit) | **Opus** | Yes — fresh-context subagent is the point |

Relevant installed skills: `design:user-research`, `design:research-synthesis`, `marketing:campaign-plan`, `marketing:draft-content`, `marketing:brand-review`, `design:design-critique`, `design:accessibility-review`, `design:ux-copy`, `brightdata-plugin:design-mirror`, `product-management:synthesize-research`.
