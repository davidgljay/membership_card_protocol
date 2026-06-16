# [Product Name] — Product Requirements Document

**Status:** Draft v0.1  
**Date:** 2026-05-17  
**Author:** David Jay  
**Protocol dependency:** Card Protocol (npm package, separate codebase and brand)

---

## Problem Statement

Small WhatsApp-based communities — churches, neighborhood mutual aid groups, dance troupes, immigrant support networks — have strong social fabric and a genuine instinct for resource-sharing, but no digital infrastructure that matches how they actually operate. Existing tools either require platform-controlled identity (Facebook Groups, Discord) that strips communities of ownership, ignore trust entirely (Craigslist, Nextdoor), or impose governance complexity that is alien to how these communities make decisions (DAOs, cooperative platforms). The result is that nearly all informal exchange happens invisibly: members post in a chaotic group chat, someone helps someone else, and the transaction leaves no record, creates no accountability, and generates no evidence of impact. When something goes wrong, there is no shared ground truth. When funders ask what the community accomplished, there is no answer. The cost of not solving this is communities that stay small, fragile, and invisible to the resources they deserve.

---

## Goals

1. **Verified exchange in under 10 minutes.** A community member with a Card can post an offer and have it accepted — with both parties' membership verified and a record created — without leaving the web browser or touching any blockchain tooling directly.

2. **Organizer onboarding in under 30 minutes.** A non-technical community organizer can set up a verified offer board for their WhatsApp group, invite their first members, and have a live community page without engineering support.

3. **Meaningful exchange volume in pilot communities.** Pilot communities average at least 5 verified exchanges per month within 60 days of onboarding, across financial and non-financial offer types.

4. **Accountable records that communities own.** Every accepted offer generates a signed, timestamped record that the community organizer can present to funders or use for internal accountability — without any platform intermediary controlling the data.

5. **Protocol adoption signal.** At least 3 communities in the first cohort use [Product Name] in ways that surface novel use cases or integration needs for the underlying Card Protocol, informing its roadmap.

---

## Non-Goals

1. **Not replacing WhatsApp as the primary communication channel.** The product integrates with WhatsApp as a distribution and onboarding mechanism but makes no attempt to replace it. The logistics conversation after an offer is accepted will usually happen off-platform, and that is expected and fine.

2. **Not handling financial transactions directly.** [Product Name] will not process payments, hold funds, or disburse money in v1. Financial asks are a supported offer type, but the actual movement of money happens through whatever mechanism the community already uses (Venmo, cash, PayPal). A human treasurer remains in the loop.

3. **Not providing need verification or means testing.** The product verifies community membership, not the legitimacy or urgency of any specific need. The "solidarity not charity" principle is a design constraint: anyone who belongs to the community can request resources, and the community's human judgment governs disbursement.

4. **Not building democratic governance or voting mechanisms.** Authorization for resource disbursement flows through the Steward and Organizer roles, not community-wide votes. This is a deliberate departure from the DAO model and reflects how small communities actually make decisions.

5. **Not aggregating offers across multiple communities in v1.** Multi-community Card support — where a member can access offer pools from several communities they belong to — is a meaningful future feature but introduces significant complexity around privacy and trust context. Out of scope for v1.

6. **Not building the Card Protocol itself.** The underlying credential infrastructure (Card issuance, chain verification, revocation, HTTPS messaging) is provided by the Card Protocol npm package. [Product Name] is a consumer of that protocol, not its implementation.

---

## User Personas

### The Organizer
A community leader — a pastor, a mutual aid coordinator, a dance group founder — who holds the social trust of the community and is responsible for its health. Technically competent enough to use WhatsApp and a web browser, but not a developer. Their time is scarce. They care about their community's wellbeing, not about technology.

### The Steward
A trusted, active member who has been given responsibility for part of the community's operation — facilitating exchanges, welcoming new members, handling sensitive situations. Designated by the Organizer. Comfortable with slightly more complexity than a regular member.

### The Member
An ordinary community participant. They joined because someone they trust invited them. They may need something, have something to offer, or both. They will not read documentation. The onboarding experience must be intuitive enough to complete via a WhatsApp message and a link tap.

---

## User Stories

### Organizer
- As an Organizer, I want to create a community page linked to my WhatsApp group so that my members have a verified space to exchange resources.
- As an Organizer, I want to invite members by sending them a Card invitation link via WhatsApp so that they can join without creating a separate account.
- As an Organizer, I want to designate trusted members as Stewards so that I can share the responsibility of managing the community offer board.
- As an Organizer, I want to revoke a member's Card if they violate community trust so that accountability is enforceable and the community feels safe.
- As an Organizer, I want to see an activity summary of exchanges that have occurred so that I can report impact to funders and celebrate community generosity.
- As an Organizer, I want to see the full invite chain for any member so that I know who vouched for them and can trace accountability if something goes wrong.

### Steward
- As a Steward, I want to review incoming offers before they go live so that the offer board stays relevant and safe.
- As a Steward, I want to send Card invitation links to prospective members so that I can grow the community without requiring the Organizer to manage every invitation.
- As a Steward, I want to see a log of exchanges in my area of responsibility so that I can spot patterns and follow up where needed.

### Member
- As a Member, I want to receive an invitation link via WhatsApp and complete onboarding in under 5 minutes so that getting a Card does not feel like a separate project.
- As a Member, I want to post an offer — a skill, a good, a bit of time, or a financial contribution — signed with my Card so that other members can see it comes from a verified community participant.
- As a Member, I want to browse the community offer board without needing to log in every time so that checking what's available feels natural and low-friction.
- As a Member, I want to accept an offer by attaching my Card so that the offerer is notified, our exchange is on record, and neither of us had to share personal contact information publicly.
- As a Member, I want to receive a private message through the app when someone accepts my offer so that I can begin the logistics conversation without my contact details being publicly visible.
- As a Member, I want to invite someone I trust to the community so that the network grows through relationships, not open signups.
- As a Member making a financial ask, I want to post a request for resources from the community fund so that I can ask for support without the vulnerability of a public post requiring immediate response.

---

## Requirements

### P0 — Must Have (MVP cannot ship without these)

**Card issuance via invitation link**
- A member receives a URL (delivered via WhatsApp or any channel) that initiates Card onboarding
- Onboarding creates a keyring and keypair using the Card Protocol npm package; the user never sees raw key material
- The completed Card is registered and the member can access the offer board immediately after
- *Acceptance criteria:* A non-technical user can complete onboarding on mobile in under 5 minutes with no prior knowledge of the protocol; the resulting Card is verifiable via the Card Protocol

**Offer creation**
- A member with a valid Card can create an offer with: title, description, category (skill / good / time / financial ask), and optional expiry date
- The offer is signed with the member's Card at creation time
- Offers are visible on the community offer board
- *Acceptance criteria:* The signed offer can be independently verified via the Card Protocol; category filter works on the board; offers without expiry remain active until manually closed

**Offer acceptance**
- A member with a valid Card can accept an open offer
- Acceptance attaches the accepting member's Card to the exchange record
- Acceptance triggers a notification to the offerer notifying them of the acceptance and the acceptor's Card pointer
- The exchange record (offer Card + acceptance Card + timestamp) is created and stored
- *Acceptance criteria:* The offerer receives a notification within 60 seconds of acceptance; the exchange record is independently verifiable; a member cannot accept their own offer

**Card verification display**
- Every offer on the board shows a visible verification badge indicating the offerer's Card is valid and in good standing
- Clicking the badge shows the Card's chain summary: who issued it, when, and its current status
- *Acceptance criteria:* A revoked Card causes the offer to display a clear "membership not in good standing" warning; chain summary is accurate and fetched in real time

**Organizer dashboard**
- Organizer can view all members and their Card status (active / revoked)
- Organizer can generate and send invitation links to new members
- Organizer can revoke a member's Card with a reason (stored in the revocation log)
- Organizer can designate members as Stewards
- *Acceptance criteria:* Revocation takes effect on the offer board within 60 seconds; Organizer can view the full invite chain for any member

**Exchange record and basic activity log**
- Every accepted offer produces a signed, timestamped exchange record visible to Organizers and Stewards
- The log shows: offer title, category, offerer Card (anonymized by default, expandable), acceptor Card, date
- *Acceptance criteria:* Records persist and are exportable as CSV; Organizer can share a link to a read-only impact summary

---

### P1 — Should Have (high-priority fast follow)

**Offer moderation queue**  
Stewards can review offers before they appear publicly on the board. Organizer can configure whether moderation is required or optional per community.

**In-app chat thread on acceptance**  
Rather than just sending a single notification, the acceptance flow opens an in-app chat thread between offerer and acceptor. This creates an accountable channel for the logistics conversation that both parties can optionally share with Stewards if needed. Off-app conversation remains the expected norm; this is an opt-in accountability feature.

**Offer categories and filtering**  
Skill, Good, Time, and Financial Ask categories are filterable on the offer board. Members can search by keyword.

**Offer expiry and renewal**  
Offers can have an expiry date. Offerers receive a notification before expiry and can renew with one action.

**Member profile page**  
Each member has a minimal profile page showing their active offers and (optionally) their exchange history. Linked to their Card pointer, not a separate account.

**Impact summary shareable page**  
Organizer can generate a shareable, read-only impact page showing: total exchanges, category breakdown, member count, and timeline — suitable for sharing with funders. No individual member data is exposed without consent.

**Financial ask with Steward approval flow**  
A financial ask offer type requires Steward approval before appearing on the board. When a Steward with appropriate Card scope approves, the ask goes live. Approval is logged in the exchange record. The Steward does not handle money — they confirm the ask is legitimate and the requestor is a verified member.

---

### P2 — Future Considerations (design should not foreclose these)

**Multi-community Card aggregation**  
A member holds Cards from multiple communities and can access offers from all of them in a single interface. Privacy controls allow members to choose which communities can see their offers and acceptances.

**Annotation layer**  
Either party in an exchange can file a Card-signed report with community Stewards if the exchange goes poorly. Reports are not public by default; they are visible only to Stewards and the Organizer. A pattern of reports against a member can trigger a Steward review.

**Community federation**  
Two communities can establish a trust relationship so their members can access each other's offer boards. Governed by Organizer-level Card signing on both sides.

**Matrix room integration**  
A community can provision a Card-gated Matrix room alongside the offer board. Members use their Card to access the room. Useful for communities that want to migrate their WhatsApp group to a more federated communication platform over time.

**Mobile-native onboarding**  
A lightweight mobile app or PWA that stores sub-Card keys in the device's secure enclave, removing the need to manage a keyring manually. Improves the security posture for members who are sensitive to key management.

---

## Success Metrics

### Leading Indicators (evaluate at 30 days post-launch per community)

| Metric | Target | Measurement |
|--------|--------|-------------|
| Organizer onboarding completion rate | >60% complete setup in one session | Funnel completion in product analytics |
| Member Card activation rate | >40% of invited members create Card within 7 days of invitation | Card issuance log vs. invitation log |
| Offers posted per community per month | ≥5 active offers at any given time | Offer board state |
| Offer acceptance rate | >25% of offers receive at least one acceptance | Acceptance events / active offers |

### Lagging Indicators (evaluate at 90 days)

| Metric | Target | Measurement |
|--------|--------|-------------|
| Community retention | >70% of onboarded communities still active at 90 days | Monthly active organizer sessions |
| Exchange depth | Average member completes ≥2 exchanges (offered or accepted) | Exchange record per Card |
| Organic referral | ≥1 new community joining per 3 existing communities | Referral source tracking |
| Organizer-reported funder use | ≥2 organizers use impact export for a real funding conversation | Qualitative interview |

---

## Open Questions

| Question | Owner | Blocking? |
|----------|-------|-----------|
| **Product name** | David | **Open** — the underlying protocol is the "Card Protocol," but this mutual-aid product needs its own distinct name. No product name has been chosen; the `[Product Name]` placeholders throughout this document correctly reflect that. (INC-23 resolved the *protocol* name only.) |
| Key custody UX: what happens when a member loses access to their keyring? What is the recovery flow visible to the user? | Engineering + Design | Yes — must be designed before onboarding flow |
| WhatsApp onboarding mechanism: does this flow through Rhizal, a standalone Card Protocol bot, or a hybrid? | Engineering | Yes — determines onboarding architecture |
| Monetization model: free for communities, grant-funded, freemium with paid tiers, or something else? | David | No — but affects scope of impact measurement features |
| First pilot community: which specific community will run the first test, and what offer types will they start with? | David | No — but must be identified before design begins |
| HTTPS notification reliability at MVP scale: what are the failure modes and retry strategy if a notification doesn't deliver? | Engineering | No — but should inform P0 acceptance criteria |
| Data residency: where do exchange records and offer content live? (IPFS? Hosted DB?) What are the privacy implications for sensitive communities? | Engineering | No — but should be decided before any security-sensitive community onboards |

---

## Timeline Considerations

No hard external deadlines are currently known. Suggested phasing:

**Phase 0 — Protocol foundation (parallel track, separate codebase)**  
Card Protocol npm package reaches a working proof-of-concept: Card issuance, verification, revocation, and HTTPS message delivery. This is a prerequisite for building the product on a real credential layer rather than a mock. May use simplified key custody in early versions.

**Phase 1 — Private pilot with one community**  
Build P0 requirements against the Card Protocol PoC. Onboard one known, trusted community (likely a mutual aid or community organizing group David has an existing relationship with). Goal is to validate the offer-accept-notification flow with real people, not to achieve polished UX.

**Phase 2 — Expanded pilot (3–5 communities)**  
Incorporate feedback from Phase 1, add key P1 features (moderation, in-app chat thread, financial ask flow), and onboard a small cohort of diverse communities (at least one church-type group, one activist/mutual aid group). Begin measuring against success metrics.

**Phase 3 — Public availability**  
Address open questions around data residency, recovery flows, and moderation tooling. Publish the Card Protocol as a stable, documented npm package with this product as the reference implementation.
