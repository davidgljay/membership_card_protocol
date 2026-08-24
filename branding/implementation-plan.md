# Membership Card Protocol — Marketing & Branding Implementation Plan

*Companion to [strategic-plan.md](./strategic-plan.md). Created 2026-08-10.*

All documents land in `card_protocol/branding/` unless noted. The site is built in the separate `mcard_landing` repo.

**Legend:** `[D]` = David does it · `[C]` = Claude does it · `[J]` = joint decision

---

## Phase 0 — Groundwork

Small, mechanical, unblocks everything else.

### 0.1 Archive legacy branding material `[C]` — *Haiku*
Prepend a `> **Superseded 2026-08-10.** Retained for reference. Canonical name is Membership Card Protocol.` header to `dnp_overview.md`, `technical_overview.md`, `card_design_guide.md`. Move `landing_page/` reference note into `branding/legacy/README.md` explaining what's reusable (the Taryn/Fatima narrative in `dnp_overview.md` is the most valuable surviving asset; the color palette is a live candidate, not legacy).
- context: `branding/*.md`, strategic-plan.md §Decisions
- done when: every legacy file carries the header; `color_palette.md` explicitly *not* marked superseded.

### 0.2 Create and connect `mcard_landing` repo `[D]`
Create the repo, add it as a Cowork folder so Claude can write to it.
- context: none
- done when: Claude can write a file to the repo root.

### 0.3 Extract the honest capability inventory `[C]` — *Sonnet, `Explore` subagent*
Read `specs/`, `press/`, `relay/`, `wallet-service/`, `membership_card_verifier/`, `app-sdk/` and produce a one-page status table: for each of the five near-term capabilities, what exists, what's stubbed, what's untouched. This is the factual floor under every claim.
- context: `card_protocol/specs/`, component directories, README.md
- done when: `branding/capability-status.md` exists with a per-capability build status and a confidence note. **David reviews and corrects before it's used** — code state and shipping reality aren't the same thing.

---

## Phase 1 — Discovery

The interview is the heart of this phase. Everything downstream is synthesis of it.

### 1.1 Prepare the audience interview `[C]` — *Opus*, skill: `design:user-research`
Draft a structured interview guide, then run it conversationally. Cover:
- Who are the 3–5 audiences? Push for named archetypes with real referents ("the person who runs the Thursday running club") over categories ("community organizers").
- Per audience: what are they doing instead today, what breaks, what's the single feature that lands, what's the objection that kills it.
- Force a ranking of the five capabilities against Open Question A — which one anchors the headline.
- Where does each audience's skepticism live: privacy, crypto associations, "another platform," effort to adopt?
- context: `branding/dnp_overview.md`, `branding/capability-status.md`, README.md, strategic-plan.md
- done when: guide drafted and reviewed by David before the interview runs.

### 1.2 Run the audience interview `[J]` — *Opus, interactive*
Conversational, not a questionnaire. Claude probes and pushes back rather than transcribing. Expect 45–90 minutes across one or more sessions.
- context: the guide from 1.1, all Phase 0 outputs
- done when: raw notes captured in `branding/research/interview-audiences.md`.

### 1.3 Synthesize into audience profiles `[C]` — *Opus*, skill: `design:research-synthesis`
- context: `branding/research/interview-audiences.md`
- done when: `branding/audiences.md` contains 3–5 profiles, each with: archetype, current alternative, core pain, hero capability, primary objection, and where they can be found online.

### 1.4 Reference site research `[C]` — *Sonnet, `general-purpose` subagent*, skill: `brightdata-plugin:design-mirror`
Find 6–8 candidate reference sites, then narrow to a recommended 2. Look at protocol/infrastructure projects that successfully addressed non-technical audiences, and at pre-launch sites that handled "not ready yet" gracefully. Suggested starting territory: Matrix, Bluesky/AT Protocol, Signal, Are.na, Obsidian, Ghost, Mastodon/joinmastodon, Fediverse project pages, ActivityPub-adjacent projects, civic-tech and public-interest tech orgs. For each: what it does well structurally, what to steal, what to avoid.
- context: `branding/audiences.md`, strategic-plan.md §Decisions 3 and 5
- done when: `branding/reference-sites.md` with 6–8 analyzed and 2 recommended, each with a screenshot or structural outline. **David picks the final 1–2.**

### 1.5 — Phase 1 Milestone Review `[C]` — *Opus, fresh-context subagent*
- context: `branding/capability-status.md`, `branding/audiences.md`, `branding/reference-sites.md`, strategic-plan.md §Goals
- checks: Do the audience profiles' hero capabilities actually exist in the capability status doc? Do the reference sites suit the audiences identified, or were they chosen on David's taste? Did the interview surface anything that invalidates a strategic goal?
- done when: contradictions resolved in place; `branding/milestones/phase-1-summary.md` written; David agrees to proceed.

---

## Phase 2 — Brand and message

### 2.1 Draft the assurance register `[C]` — *Opus*
6–12 numbered assurances, each with: plain-language statement, technical statement, build status, spec link. This is the hardest writing in the project — the two renderings must be the *same* claim, not a simplification and an unrelated technical note.
- context: `branding/capability-status.md`, `specs/ARCHITECTURE.md`, `branding/audiences.md`, strategic-plan.md §Goal 2b, Open Question B
- done when: `branding/assurances.md` exists; **David has resolved Open Question B** (status-label granularity) and signed off on every claim as defensible.

### 2.2 Draft the brand and framing guide `[C]` — *Opus*
Name and naming rules (component naming: press, relay, wallet, verifier — which are public-facing terms?), one-liner, positioning statement, voice principles with examples, terminology do/don't table (including how to talk about crypto per Decision 5), and visual direction building on `color_palette.md`.
- context: `branding/audiences.md`, `branding/assurances.md`, `branding/color_palette.md`, `branding/card_design_guide.md`, `branding/dnp_overview.md`, strategic-plan.md
- done when: `branding/brand-guide.md` exists and David has reviewed the voice section specifically — voice is the part that's wrong if it's wrong.

### 2.3 Messaging hierarchy and site conversion map `[C]` — *Opus*
Headline, three pillars, per-audience message variants. Plus: the site's user map — who lands, what they need in order, what the primary and secondary conversions are, and what the developer path looks like.
- context: `branding/brand-guide.md`, `branding/audiences.md`, `branding/assurances.md`
- done when: `branding/messaging.md` exists; every claim in it cites an assurance number.

### 2.4 — Phase 2 Milestone Review `[C]` — *Opus, fresh-context subagent*, skill: `marketing:brand-review`
- context: `branding/assurances.md`, `branding/brand-guide.md`, `branding/messaging.md`, `branding/capability-status.md`
- checks: Every messaging claim traces to an assurance; every assurance traces to a real capability; the voice guide and the actual messaging copy are in the same voice (they often aren't); no blockchain leakage into organizer-facing copy; no overclaiming given pre-launch status.
- done when: `branding/milestones/phase-2-summary.md` written; David approves.

---

## Phase 3 — Design

### 3.1 Low-fidelity wireframes `[C]` — *Sonnet*, visual tooling
Two or three structurally different directions for the homepage, rendered as viewable HTML/SVG artifacts. Not styled — structure, hierarchy, section order, CTA placement. Each direction should make a different bet (e.g. narrative-led vs. capability-led vs. assurance-led).
- context: `branding/messaging.md`, `branding/reference-sites.md` (David's chosen 1–2), `branding/audiences.md`
- done when: directions presented; **David picks one and gives feedback.**

### 3.2 Iterate to a chosen wireframe `[C]` — *Sonnet*, skill: `design:design-critique`
Refine the chosen direction across 2–3 rounds. Add secondary pages if the map calls for them (developer page, about).
- context: chosen direction from 3.1, David's feedback
- done when: `mcard_landing/design/wireframe-final.html` approved by David.

### 3.3 Visual direction and image asset plan `[C]` — *Opus for strategy, Sonnet for production*
Decide what imagery the site needs and how each piece gets made. Likely mix: SVG/CSS card mockups (Claude can build these directly — highest fidelity-to-effort ratio here, and they're the core visual), diagrammatic illustrations of issuance and verification flows, and any photographic or illustrative texture. For each asset: what it is, how it's produced, licence status.
- context: `branding/card_design_guide.md`, `branding/color_palette.md`, `mcard_landing/design/wireframe-final.html`, `branding/brand-guide.md`
- done when: `branding/image-assets.md` lists every needed asset with a production route; card mockups drafted as SVG for David's review.
- note: Canva is a fallback for anything Claude can't produce directly. It requires authorization in claude.ai connector settings before use.

### 3.4 — Phase 3 Milestone Review `[C]` — *Opus, fresh-context subagent*
- context: `mcard_landing/design/wireframe-final.html`, `branding/image-assets.md`, `branding/messaging.md`, `branding/brand-guide.md`
- checks: Does the wireframe have a slot for every message in the hierarchy, and does every slot have a message? Do the planned assets match the visual direction in the brand guide? Is the developer path actually present?
- done when: `branding/milestones/phase-3-summary.md` written.

---

## Phase 4 — Copy and build

### 4.1 Section-by-section copy drafting `[J]` — *Sonnet*, skills: `marketing:draft-content`, `design:ux-copy`
David writes what he wants to write; Claude drafts the rest and edits throughout. Work section by section against the wireframe, not as one document. Microcopy (form labels, CTA text, confirmation states) handled with `design:ux-copy`.
- context: `branding/messaging.md`, `branding/brand-guide.md` §Voice, `branding/assurances.md`, `mcard_landing/design/wireframe-final.html`
- done when: `mcard_landing/content/copy.md` complete for every section, David approves.

### 4.2 Choose and wire email capture `[J]` — *Sonnet*
Pick a static-friendly service (Buttondown, Listmonk, Formspree, etc.) weighed on privacy posture — which matters more than usual given the protocol's positioning. Wire the form, confirm submissions actually arrive.
- context: `branding/messaging.md` §CTA, strategic-plan.md §Remaining assumptions
- done when: a test submission from a browser reaches David's inbox/list.

### 4.3 Build the Jekyll site `[C]` — *Sonnet*
Fresh Jekyll build in `mcard_landing`: layouts, includes, SCSS from the palette, responsive, no jQuery/Bootstrap inheritance from the legacy site. Assurance register rendered from a data file so it stays maintainable.
- context: `mcard_landing/design/wireframe-final.html`, `mcard_landing/content/copy.md`, `branding/color_palette.md`, `branding/image-assets.md`
- done when: `bundle exec jekyll build` clean; site renders correctly at mobile and desktop widths.

### 4.4 Produce final image assets `[C]` — *Sonnet*
- context: `branding/image-assets.md`, `branding/color_palette.md`
- done when: all assets in `mcard_landing/assets/`, optimized, with alt text.

### 4.5 Deploy to GitHub Pages `[C]` — *Haiku*
- context: `mcard_landing/`
- done when: live at a real URL, HTTPS, custom domain configured if David has one.

### 4.6 — Phase 4 Milestone Review `[C]` — *Opus, fresh-context subagent*, skills: `design:accessibility-review`, `marketing:brand-review`
- context: the live URL, `branding/assurances.md`, `branding/brand-guide.md`, `branding/messaging.md`
- checks: WCAG 2.1 AA contrast against the teal/sand palette (worth real scrutiny — `Teal 100` on `Teal 800` and any grey-on-warm-white pairing are the likely failures); every link works; copy matches the approved voice; **claim audit** — read the live site as a skeptical outsider and flag anything that implies the protocol is usable today; mobile rendering verified by screenshot.
- done when: issues fixed; `branding/milestones/phase-4-summary.md` written.

---

## Phase 5 — Promotion

### 5.1 Network interview `[J]` — *Opus, interactive*
A second, different interview — this one about people, not ideas. Walk constituency by constituency (community organizers, civic tech, funders/foundations, privacy and security people, developers, journalists) and inventory who David actually knows: name, relationship strength, why they'd care, and what the right ask is. Claude probes for the connections David undervalues — the "oh, and there's someone who..." names that surface twenty minutes in.
- context: `branding/audiences.md`, live site URL
- done when: `branding/research/interview-network.md` captured.

### 5.2 Build the target list `[C]` — *Sonnet*
Segment by constituency; rate warmth (1–3); assign a specific ask per person; sequence into waves — warmest and most likely to give useful feedback first, so the message improves before it reaches the people who matter most.
- context: `branding/research/interview-network.md`, `branding/audiences.md`
- done when: `branding/target-list.md` exists (or a spreadsheet if David prefers). **Contains personal contact information — confirm it should be committed to the repo or kept local before writing.**

### 5.3 Draft outreach templates `[C]` — *Sonnet*, skill: `marketing:draft-content`
Three genuinely distinct registers: direct/personal email (warm, specific, references the shared history), LinkedIn (professional, credibility-forward, shorter), Bluesky (public, conversational, thread-shaped — and worth a different content strategy since it's broadcast rather than one-to-one). Variants per constituency where the pitch differs.
- context: `branding/messaging.md`, `branding/brand-guide.md` §Voice, `branding/target-list.md`
- done when: `branding/outreach-templates.md` approved by David. Templates are scaffolds — every direct message gets personalized before sending.

### 5.4 Promotion calendar `[C]` — *Sonnet*, skill: `marketing:campaign-plan`
6–8 weeks, wave by wave, with content beats for Bluesky and LinkedIn between outreach pushes. Define numerically what a successful first wave looks like.
- context: `branding/target-list.md`, `branding/outreach-templates.md`, `branding/messaging.md`
- done when: `branding/promotion-plan.md` exists with a week-by-week calendar and success criteria.

### 5.5 — Phase 5 Milestone Review `[C]` — *Opus*
- context: all Phase 5 outputs, `branding/messaging.md`, live site
- checks: Do the outreach messages and the site say the same thing? Is the ask in each template consistent with what the CTA actually delivers (1–2 emails/month)? Is the calendar realistic for one person doing this alongside building the protocol?
- done when: `branding/milestones/phase-5-summary.md` written.

---

## Clarification Checkpoints

Named points where Claude stops and waits, regardless of momentum.

1. **Capability truth check** — after 0.3, before any claim is written. David must correct the capability status doc. Code state ≠ shipping reality, and everything downstream inherits this error if it's wrong.
2. **Assurance sign-off** — after 2.1. Every assurance is a public promise. David approves each one individually before it appears anywhere.
3. **Voice approval** — after 2.2. If the voice is wrong, all copy is wrong. Explicit approval of the voice section before 4.1 begins.
4. **Wireframe direction** — after 3.1. No refinement work until David has picked a direction.
5. **Before writing personal contact data to the repo** — at 5.2. Confirm the file should be committed at all; default to local-only.
6. **Before any external send** — nothing is posted to Bluesky or LinkedIn, and no email goes out, without David reviewing that specific message. Claude drafts; David sends.
7. **Overclaiming tripwire** — at any point, if a draft implies the protocol is usable today, stop and flag rather than softening the language unilaterally.
8. **Scope drift** — if any phase runs past roughly double its expected effort, pause and reassess rather than pushing through.

---

## Model and delegation summary

| Phase | Work | Model | Delegate |
|---|---|---|---|
| 0.1, 4.5 | Mechanical file ops, deploy | Haiku | Yes |
| 0.3 | Codebase capability audit | Sonnet | Yes — `Explore` |
| 1.1–1.3 | Interview design, running, synthesis | Opus | No — interactive |
| 1.4 | Reference site research | Sonnet | Yes — `general-purpose` |
| 2.1–2.3 | Assurances, brand guide, messaging | Opus | No — needs full context |
| 3.1–3.2 | Wireframes and iteration | Sonnet | No — feedback loop with David |
| 3.3 | Asset strategy / production | Opus / Sonnet | Production only |
| 4.1 | Copy drafting | Sonnet | Per-section subagents |
| 4.3–4.4 | Jekyll build, assets | Sonnet | Yes |
| 5.1 | Network interview | Opus | No — interactive |
| 5.2–5.4 | List, templates, calendar | Sonnet | Partially |
| All milestone reviews | Consistency and claim audits | **Opus, fresh-context subagent** | **Yes — the fresh context is the point** |

The milestone reviews are the one place where delegation isn't about saving effort. A subagent that hasn't watched the documents get written will catch drift that Claude-in-conversation is blind to, having rationalized each step along the way.
