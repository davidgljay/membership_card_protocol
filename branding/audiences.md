# Audiences

*Phase 1.3 deliverable. Synthesized from [research/interview-audiences.md](./research/interview-audiences.md), 2026-08-16.*

> **How to read this.** These profiles are a **hypothesis the site exists to test**, not a settled finding. The frontend deliberately isn't being built until real partner feedback exists; this document is the best current guess about who those partners are. Expect to revise it after the first outreach wave.

---

## The core value proposition

**Resource-sharing among people who already trust each other.** One value, across every audience. What varies is the kind of trust being asserted — membership, professional standing, chapter affiliation.

Two boundaries that follow from it:

- **The protocol doesn't help you build a community.** It gives the community you already have things it couldn't do before. Skilled organizing is a prerequisite, not something the software replaces.
- **Communities don't switch — they add.** Nobody leaves WhatsApp. Cards are adopted for what WhatsApp can't do. This is a far lower bar than migration and should shape every piece of copy.

## The qualifying test

A community is a candidate if it has:

1. A **recurring meeting with regular attendees**, and
2. An **existing shared channel** (WhatsApp, Discord, Signal, listserv).

Bonus, not required: already shares childcare, money, or other collective care. *"Part of the goal is to get them there."*

This is the self-recognition language for the site — a reader should be able to decide "that's us" in one sentence.

## The paired-service problem

**A card on its own does nothing.** Its value is access, so a rollout must be paired with something the community actually wants access to — a shared calendar, a run leaderboard, a free-stuff list, a mutual aid board, a members-only game server.

What that service should be, for any given community, is **the biggest open question in the project** and the primary thing the site exists to discover.

Three consequences:

| Consequence | Implication |
|---|---|
| First wave is **concierge, not self-serve** | David co-designs with each organizer. Success is ~5 excellent fits, not signup volume. |
| The site should **qualify hard** | Closer to an application than an email capture. |
| The discovery question is the hook | *"What would your community share if it were easy?"* — simultaneously the value prompt, the qualifier, and the opening line of a real conversation. |

## Terminology

The object is a **card**, not a "membership card." In member-facing language it takes the community's name: *"your Boots on the Ground card."*

"Membership Card Protocol" remains the name of the protocol itself — the thing developers, partners, and funders encounter. But a member being handed one is never told they're receiving a membership card. They're getting their club's card.

## Two-sided adoption

**The organizer is the buyer. The member is the user.** They adopt for different reasons and the organizer has to sell it onward.

- **Members** adopt because cards get them into something worth having, with better privacy as a bonus. They do not adopt to generate data for anyone.
- **Organizers** adopt for the same reason, plus the prospect that a healthy community becomes provable.
- **Funders** are not a launch audience. That market is being built in parallel.

→ **Copy deliverable:** the site must hand organizers something they can paste into a group chat without embarrassment.

---

# Primary audience

**The site is written for club builders.** Everything else is secondary. This is a deliberate narrowing: copy that speaks to a line-dancing club and a professional body at the same time ends up generic, and generic copy fails the recognition test. An organizer should read the first screen and think *that's us*.

## Club builders

**Archetype.** The organizer of a local club that meets regularly — line dancing in Tulsa, a climate group in their twenties that drinks beer and takes action, a hiking group, a fan community. The BuildIRL orbit. Desiree from the Substack post is the canonical portrait.

**Doing today.** WhatsApp or Discord for comms, plus a duct-taped stack: Eventbrite for tickets, GoFundMe for money, a Squarespace site a volunteer threw together, and most of the important knowledge living in the organizer's head.

**Core pain.** Success creates burnout. The more the community thrives, the more unpaid work piles onto one or two people. Sharing anything beyond conversation means either building a website with logins or giving up. *"Success at a thing that our world desperately needs means failure."*

**Hero framing.** Your group chat can only hold a conversation. Cards let your members build things for each other.

**Primary objection.** Switching cost, and it's not really about the software — it's about asking fifty people to install something. Answer: they don't switch, they add.

**Month-one service candidates.** Shared calendar with member-posted events; free-stuff or lending list; mutual aid request board; a members-only game server; skill-share directory.

**Why they're primary.** Warmest relationships, most acute pain, the platonic version of the use case, and already convened. Weakest on money and on a self-evident month-one service — but the site is a discovery instrument, and this is the audience that teaches the most.

**Where they are.** BuildIRL community and its wind-down network; the grassroots club-builder gatherings David is helping convene; Relationality Lab monthly gatherings; the Substack readership.

**Warmth: 3/3.**

---

# Secondary

## Professional networks — the validation cohort

**Archetype.** Integrity Institute (David's former colleagues); professional bodies like ACOG. A bounded group of practitioners who need to know a stranger has real standing.

**Doing today.** Slack workspaces, listservs, LinkedIn, conference hallways. Verification is social and slow — you vouch for someone, or you don't reply.

**Core pain.** *Is this person worth my time?* Expertise is asserted, not demonstrable. The cost of engaging with strangers is high enough that valuable connections don't happen.

**Hero framing.** Know that the person messaging you has the standing they claim — without them handing over their identity, and without you running a background check.

**Primary objection.** "We don't need another identity protocol." Answer: identity is the mechanism, not the point. The comparison isn't Sign-In-With-Whatever; it's the duct-taped stack.

**Month-one service candidates.** A members-only forum or Matrix space with verified standing; a "reach a stranger in the network" inbox; expertise directory; peer-review or referral routing.

**Role.** Same core value as clubs, with a second layer of trust. Institutional budgets and clearer professional incentives. They **validate whether the message stretches** — if a pitch written for clubs also lands with Integrity Institute, it generalizes. Approach after the club message is working, not in parallel.

**Warmth: 3/3** for Integrity Institute; lower elsewhere.

## National associations

**Archetype.** US Chamber of Connection, RSA. A national body with local chapters and a shared mission.

**Doing today.** Central membership databases, chapter-level spreadsheets, SSO that breaks at the chapter boundary or forces everyone into one system.

**Core pain.** Trust has to flow national → chapter → member, and every tool assumes one flat central authority.

**Hero framing.** The only structure that matches the shape of your organization: chapters issue their own cards, everyone can verify the lineage back to national, and nobody maintains one giant database.

**Why they matter.** The best structural fit for delegated issuance and chain-of-trust — the capability with no real alternative. The only category with budget, and a plausible route to paying Relationality Lab to run an implementation. Move slowly; will ask hard security questions.

**Warmth: 3/3** — warm relationships across the movement organizations.

**Status: opportunistic, handled offline.** Paid implementation is a side effect, not the business model, so the site does not need a services-inquiry path. Revisit if that changes.

## Elite networks

**Archetype.** Silicon Valley VC circles, high-net-worth clubs.

**Hero framing.** Vet who's in the room before admitting them; make the strength of the network legible.

**Why they're here.** The data-validation → resourcing case is easiest to make, and it's a route to mobilizing capital toward the north star.

**Tension.** Not values-aligned. Risks pulling the brand toward exclusivity, which is the opposite of the movement framing. Looser connections. **Warmth: 1/3.**

**Status: opportunistic and offline — confirmed.** Does not appear on the site in any form.

---

# Deferred, with reasons

| Audience | Why deferred |
|---|---|
| **Security-critical groups** (mutual aid networks resisting ICE, and similar) | Explicitly last. An MVP won't be highly secure, and David wants a bench of cybersecurity advisors on the Matrix implementation first. Being early-and-broken has consequences here it doesn't elsewhere. |
| **Creators** | An audience isn't a community — trust runs vertically to the creator, not laterally between members, and lateral trust is what makes shared resources work. Violates the "no building from scratch" rule. **Two exceptions worth watching:** creators organizing around causes (e.g. Social Current), and creators coordinating via political-content backchannels. Down the road, David would like to pair organizers with audience-holders. |
| **LGBTQ youth centers, schools** | Original inspiration, still interesting, not prioritized. Youth safety raises the security bar. |
| **Political campaigns** | Premature for this site. |
| **AI agent identity** | Organizations or certifying bodies issue cards to members; those cards issue sub-cards to AI agents carrying identity, basis of trust, and scope of authority. Commercially appealing and addresses a real problem — but requires cards to be an accepted standard first, and would pull the brand toward enterprise identity. *Nothing in the positioning should make this sound off-brand if pursued later.* |
| **Software builders** | Genuinely an audience, deliberately not centered — *"prototyping/adapting open source technology is fairly cheap in an era of AI coding."* Center people building clubs, not people building software. |

---

# Cross-cutting

## Secondary CTAs

The site needs constituency-specific calls to action beyond the primary organizer path, without letting them displace it:

- **Community builders** — primary. Partner conversation.
- **Cybersecurity expertise** — recruiting the advisory bench. A specific, interesting first question exists: *does card-to-card messaging actually perform ML-KEM-768 encapsulation?*
- **Contributors** — people who want to help build the protocol. Useful as a dogfooding cohort, but insufficient alone: they need other people using it to be motivated.

## Objections, ranked

1. **Switching costs.** *"WhatsApp is the standard not because it's good but because it's familiar."* → Communities add, they don't switch.
2. **"We don't need another identity protocol."** → Identity is the mechanism, not the point.
3. **Technosolutionism — the governing constraint.** People want paths forward rooted in resourcing and lineage, and are rightly wary of tech. **Technology cannot be the protagonist.** The precise objection is *technocolonialism*, not technology: resemble Signal, avoid resembling the billionaire-led giants. Federation, privacy-by-design, and the living-wage goal answer it — but as values that come through, not as things to center.
4. **"Why be first?"** → For first adopters the benefit is shared resourcing, standalone. Data and cross-community trust come later, with scale.

## What we still don't know

- **What service makes a card worth adopting** for any specific community. The central unknown; the site's main job.
- Whether a message written for clubs also lands with professional networks — tested after the club message works, not by hedging between them now.
- Whether organizers can successfully sell cards to their own members.
- Whether "add, don't switch" holds, or whether a parallel tool just gets ignored.
