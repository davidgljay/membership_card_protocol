# Messaging & Conversion Map

*Phase 2.3 deliverable, 2026-08-16. Governed by [brand-guide.md](./brand-guide.md). Every claim traces to [assurances.md](./assurances.md).*

---

## The reader

One person, imagined specifically: **someone who runs a club that already meets.** A hundred-ish regulars, a WhatsApp group, a recurring event, and more unpaid work than is sustainable. They are competent, tired, and have been pitched community software before.

They arrive from a link — a Bluesky post, a LinkedIn message from David, a mention at a gathering. They give the page **about ninety seconds** before deciding whether this is for them.

**What has to happen in those ninety seconds:** they recognize themselves, they understand what a card would let their community do, and they believe this isn't another platform asking them to migrate. Everything else can wait for the conversation.

---

## Headline

> **Let anyone in your community**
> **Create places for your community**
> **Anywhere on the internet**

**Immediately below, within the same screen — the examples.** The headline is deliberately abstract; it only works if it resolves fast.

> A calendar anyone can post to. A list of free stuff going spare. A members-only game server. A lending library. A board for asking for help and offering it.

The list stands on its own. A club builder reading it will immediately think of the version their own community needs — that recognition is the work, and explaining it would undercut it. Per the voice principles: the reader is competent.

---

## The three pillars

Everything on the landing page belongs to one of these. If a section doesn't, cut it.

### Pillar 1 — Your community can create shared resources anywhere on the internet

*The value, inward-facing. Answers: what is this for?*

> **On "places" vs "shared resources."** The headline says *create places*; this pillar says *shared resources*. Kept deliberately distinct. Both phrases are abstract on their own, and two angles on the same idea triangulate better than one repeated phrase — "places" carries somewhere-you-go, "shared resources" carries something-you-use. Neither is asked to do the work alone; the examples underneath do that.

- Give every member a card. Anything your community makes can check it.
- No accounts, no passwords, no membership database to maintain.
- Anyone in the community can set something up, not just you. The calendar doesn't have to be your job.
- It works anywhere on the internet, not inside one app.

**Traces to:** A0 (proof opens doors), A1 (chain of verification).

**Tone note:** the third bullet carries the emotional weight. The reader is burned out; "the calendar doesn't have to be your job" speaks to that directly without ever naming burnout.

### Pillar 2 — Your community can show others it's worth trusting

*The value, outward-facing. Answers: what does this do beyond our own group?*

- A card proves your members belong, to anyone, anywhere — and reveals nothing else about them.
- Members can show affiliation when they need to be taken seriously: reaching out to an institution, joining an adjacent community, asking for resources.
- Anyone can check a card and see who vouched for it and why — following the chain back to something they already trust.
- Trust travels in both directions: a card from another community tells your members whether a stranger is worth their time.
- Your members choose what to show and when. A card can be presented without becoming an account, an email address, or a profile — and the cards someone holds aren't connected to each other.

**Traces to:** A0, A1 (chain of verification), A3 (proves one thing, reveals nothing else), A4 (cards aren't linked), A6 (each card is a private inbox).

**Privacy lives here, not in a separate section.** It isn't a side benefit sitting next to the value — it's the mechanism that makes this pillar work. Proving you belong *while revealing nothing else* is the whole difference between a card and a LinkedIn profile, and it's why showing a card doesn't cost your members anything. Stated as a property of the thing being described, not as a values claim.

Federation and open-source stay demoted to supporting messages. Privacy does not: it's a benefit, and an unusual one in a surveillance-saturated market.

**Tone note:** this is the Taryn-and-Fatima half of the story — the reason a card is worth more than a group in an app. It's also the pillar that generalizes to professional networks with almost no rewriting, which makes it the natural bridge to the validation cohort.

### Pillar 3 — Nobody has to move

*The objection killer. Answers: what will this cost me?*

- Your group chat stays exactly where it is. Cards are for the things a group chat can't do.
- Members get a card. That's the whole ask.
- No migration, no integrations, no new platform to learn.

**Traces to:** A0.

**Why it closes rather than opens.** Switching cost is the primary objection in `audiences.md` — *"WhatsApp is the standard not because it's good but because it's familiar."* Placing it last means the page runs value → value → and it costs you almost nothing, ending on ease rather than on argument. The risk is that the worry surfaces during pillar 1 and goes unanswered for two sections; if wireframe testing suggests readers stall there, a single line in pillar 1 can defuse it early without spending the pillar.

---

### Demoted: decentralization and privacy

Previously pillar 3. **Decentralization is a real property but not a value proposition** — no club builder adopts a protocol because it's federated. It moves to supporting messages and the assurances page, where it does its actual job: answering *what's the catch?* for a reader who has already decided they want the thing.

Per the brand guide, these values should come through structurally rather than being centered — which is precisely what demoting them achieves.

**Privacy is not demoted with them.** Resolved 2026-08-16: privacy moved into pillar 2, where it belongs — it's the mechanism that makes proving affiliation cheap, not a separate virtue. Federation and open-source are properties; *"reveals nothing else about you"* is a benefit.

---

## Supporting messages

Not pillars. Available as they become relevant, lower on the page or on the assurances page.

| Message | Where | Assurance |
|---|---|---|
| A card can be revoked; standing is current, not historical | Landing, brief | A2 |
| Reports come with proof; anonymity isn't impunity | Assurances page | A7 |
| Losing your phone doesn't lose your cards | Assurances page | A5 |
| Each card is a private inbox — no email or phone number | Landing, brief | A6 |
| With consent, cards can demonstrate your community's impact | Landing, one sentence | *Out of MVP — demand test* |
| Built to hold up long-term, including against quantum attack | Assurances page | A10 |
| We can't see who holds your cards or what they do with them | Landing, brief — near pillar 2 | A4, A8 |
| Nobody owns this; anyone trusted can run the infrastructure | Landing, brief | A9 |
| Open source, a project of Relationality Lab | Landing, near David | A9 |

**The impact-data sentence is a deliberate probe.** It isn't built. It stays because reactions to it are a finding — see `brand-guide.md §Positioning`. It must never escalate to "gets you funded."

---

## Message variants

### For professional networks (validation cohort)

Same three pillars, one substitution in pillar 1: *knowing the person messaging you has the standing they claim* replaces *building things together*. Everything else holds. **If this substitution requires rewriting more than a paragraph, the club message wasn't general enough** — that's the test.

### For the ecosystem (Phase 5 outreach)

Lead with the thesis rather than the product: this is infrastructure for the argument in *Relationality* — moving resources inside communities and making relational impact provable without surveillance. The audience already shares the premise; skip the setup.

### For developers

Lead with the mechanism: verification is a library, not a service. No API key, no permission, no call home. Straight to the repo.

---

## Reader journey

*Section order settled in wireframing (3.1) — see `mcard_landing/design/wireframe-final.html`.*

| # | Section | Reader's question | What answers it |
|---|---|---|---|
| 1 | Hero | "What is this?" | Three-line headline; one line naming who it's for |
| 2 | Three pillars | "What's the claim?" | Pillars 1–3 in order — the frame, stated before it's illustrated |
| 3 | Narrative | "What does that look like?" | Desiree, four beats, photograph of a real gathering |
| 4 | What you can create | "What would *we* make?" | Example menu, plus what a card actually is |
| 5 | Where the project is | "Is this real?" | Built / next / with partners — see below |
| 6 | Who's behind this | "Who are you?" | David, Relationality Lab, the book |
| 7 | Get involved | "What do I do?" | Three constituencies + form |

**Why pillars precede the narrative.** The frame comes first, then the story makes it concrete, then the examples make it actionable. A reader who bounces after the pillars has still got the whole argument; a reader who bounces during a story that hasn't yet declared its point has got nothing.

**Where the qualifier went.** It's now a single line in the hero rather than a section of its own. The narrative does most of the recognition work — a club builder reading about Desiree either sees themselves or doesn't.

### The qualifying moment

Placed early, phrased so the reader self-selects:

> This is for communities that already exist — a club that meets, a network that gathers, a group with a channel and regulars who know each other. If you've already built the trust, cards give it somewhere to go.

Does double duty: tells the right reader *that's us*, and tells the wrong reader this isn't a tool for building a community from scratch — which is [what this is not](./brand-guide.md).

### Where the project is

Placed **before** the CTA, and framed forward rather than apologetically. "Nothing works yet" is needlessly bleak when the accurate statement is that the difficult part is finished:

> **The foundations are built. The rest gets designed with partners.**
>
> The protocol itself works — issuing, verifying, messaging, revoking, all tested. What doesn't exist yet is the app you'd hold a card in, and that's deliberate: I'd rather build it with a handful of communities than guess at what they need.

Shown as three steps, so the reader can see position rather than read about it:

| Built | Next — 1 to 3 months | With partners |
|---|---|---|
| The protocol | An app to hold cards | Real communities using it |

Four jobs: nobody feels misled, the pre-launch state reads as a stage rather than a shortfall, the offer is relational rather than transactional, and it filters for people who want to shape something. **Being straight about this is itself differentiating** in a field full of vapour — but straight doesn't have to mean glum.

**Discipline unchanged:** never imply it's usable today. "Built" describes the protocol, not a product anyone can pick up.

---

## Get involved

Three constituencies, one form. Each states who it's for and what's being asked.

### 1. Community organizers

*People building communities where people regularly gather, connect, and support one another.*

Looking for partners who can test the protocol, give feedback on its implementation, and potentially take part in its governance.

### 2. Cybersecurity and trust & safety professionals

*People who can review the protocol and check whether it lives up to its assurances.*

Also people who can help design against fraud and abuse from the beginning rather than after.

**Give them a specific question, not a general invitation.** Two live ones, both real and both interesting: whether card-to-card messaging actually performs ML-KEM-768 encapsulation, and what a wallet service can infer about the set of cards a holder keeps. A concrete puzzle recruits far better than "would you review our protocol" — see `capability-status.md`.

### 3. People building community applications

*Developers, technologists, and anyone who can put together a working thing with AI coding tools.*

Build the places communities reach with their cards — calendars, directories, boards, games, whatever a community needs. Early builders shape what the protocol makes easy, and what a community can be handed on day one.

**Strategically important beyond its size.** Per `audiences.md`, a card is worthless without a paired service, so these are the people who make the first pilot possible. Not centered — the page is written for organizers — but not an afterthought either.

*Funders are not listed. David sends the site to them directly; a CTA would tilt the page toward an audience it isn't written for.*

### The form

Short, POST to David's own endpoint — no third-party email vendor holding a list of community organizers, which matters given what the page claims about privacy.

**Fields:**

| Field | Type | Notes |
|---|---|---|
| Name | text | |
| Email | text | |
| Which of these are you? | **check all that apply** | Organizer / security & T&S / builder. People are often two of these — an organizer who also codes, a T&S professional who runs a group. Forcing a single choice loses that. |
| Your community or organization | text | |
| Why are you interested in learning more? | textarea, optional | |

**The discovery question belongs in the conversation, not the form.** *"What would your community share if it were easy?"* takes real thought to answer — it's the kind of question someone works out while talking, not something to be stopped by mid-form. Asking it here would cost submissions and get shallow answers from the people who did push through.

So it moves: it's the **opening question of the first partner conversation**, where there's room to think and someone to think with. That's also where the answer is most useful, since it's the start of co-designing what a community actually gets.

*"Why are you interested in learning more?"* is the right form-sized version — low-friction, optional, and it still surfaces motivation and language worth reading.

### What the form is asking for

**Resolved: one form, and it is not an application.** It should read as *learn more and be invited into a conversation about moving the protocol forward* — never as "apply to be a partner." Nobody arriving from a Bluesky link is ready to commit their community to anything, and a form that implies otherwise filters out precisely the curious, well-connected people worth talking to.

This resolves the low-commitment-tier question by removing it. There aren't two tiers. There's one low-commitment entry, and the conversation that follows is where fit gets worked out — which is also where the concierge model actually does its qualifying, by a human rather than a form field.

**Consequences for the surrounding copy:**

- Section heading is **"Get involved,"** not "Apply" or "Become a partner."
- Button says something closer to **"Start a conversation"** than "Submit application."
- The constituency checkboxes describe *who you are*, not what you're committing to.
- State the follow-up plainly: an occasional email, and a real conversation if there's mutual interest. No implied obligation in either direction.
- The qualifying test earlier on the page does the self-selection work. The form doesn't need to repeat it.

---

## Rules for drafting

1. Every claim traces to a numbered assurance, or it's cut.
2. Every section belongs to a pillar, or it's cut.
3. The protagonist test: if the protocol is the subject more often than the community, rewrite.
4. Nothing implies the protocol is usable today.
5. No blockchain vocabulary in organizer-facing copy. Cryptography spoken about plainly where relevant.
6. Give organizers something they can paste into their group chat without embarrassment — a two-sentence version of pillars 1 and 2, written for members rather than organizers. *(Per `audiences.md`: the organizer is the buyer, the member is the user.)*
