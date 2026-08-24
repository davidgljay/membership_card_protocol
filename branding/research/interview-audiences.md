# Audience Interview — Raw Notes

*Session 1: 2026-08-15. Interviewer: Claude. Subject: David Jay. Status: **in progress** — Q22, 23, 24 outstanding, plus Q19 (business model) and Q12 (list size).*

---

## Verbatim: the party pitch (Q1)

> "The membership card protocol helps a community go from a whatsapp group or discord to something closer to a mutual aid network. Everyone in the community gets a digital membership card, and then anyone in the community can create resources that everyone else in the community can access."

## North star (Q2)

**Create a living wage for people who build community.** Local clubs, grassroots organizers. If those people don't have to stop what they're doing to make rent, there's more connection in the world — loneliness crisis and democratic health both improve.

Two routes, and the protocol serves both:
1. Help communities mobilize resources to support one another (organically supports the organizer).
2. Help community builders prove to outsiders that their community is worth investing in.

Route 2 is David's specialty — relational impact data — and the subject of his book.

**Source documents:** [Relationality](https://relationalitybook.com) (North Atlantic Books; blurbs from Andrew Solomon, Lennon Flowers) and the Substack post ["Let's Create A Living Wage For People Building Small Scale Community"](https://relationality.substack.com/p/lets-create-a-living-wage-for-people) (May 2026). The Substack post is the single most useful marketing source document in the project — see below.

## Institutional context

- The protocol is a project of **Relationality Lab** (relationalitylab.org), publicly tied to David and the book. *(Resolves the personal-brand question — Q9/Q11.)*
- Relationality Lab already provides **relational impact reporting** as a service. The data-donation feature is therefore the productization of existing manual work, not a speculative new product.
- David founded **AVEN** (Asexual Visibility and Education Network) — built a large online community from scratch.
- Existing warm channels: Substack ("Loneliness And"), monthly Relationality Lab virtual gatherings with a signup list, book clubs, speaking circuit.

---

## The Desiree framework (from the Substack post)

Four phases by which community work becomes paid work: **value → data → legibility → expansion.** Desiree runs a line-dancing club in Tulsa; the arc takes her from burnout to three living wages in 18 months.

Analytically important: in this narrative the technology that matters is the **verification layer** — "a trusted third party confirms that this is what Eventbrite says and not what Desiree made up," the exportable data package, Marco's signed writeup that Desiree can reuse. Phase 1 (the community showing up for each other) happens without technology.

Also from the post, reusable as brand material:
- **The sushi argument** — an ecosystem that structurally resists consolidation; private equity has burned billions failing to build "the Chipotle of sushi." This is how to explain decentralization to community organizers *without saying blockchain.*
- **"Technology that is humble and rooted in the communities it serves"** — candidate voice principle.
- **"Success at a thing that our world desperately needs means failure"** — the structural insight; the most-quoted line in the comments.
- Explicit anti-VC-platform positioning: Desiree gets help from a movement of mentors and open-source developers, not a funded platform.

---

## Positioning resolution (Q13) — decided

Two candidate pitches were in tension: resource-sharing (Phase 1) vs. legibility/data (Phases 2–3). **Resolved in favor of resource-sharing as the adoption driver**, with data as a follow-on benefit.

David's reasoning: *"People in the community won't start using these cards because they want people running communities to have data. They'll use them because it's a cool way to create shared resources, and maybe they'll appreciate the enhanced security. So the data collection and validation needs to be a follow-on benefit, not the use case that drives community adoption."*

Additional honesty constraint: **there aren't yet many funders who care about this class of data.** David is building that market in parallel. So the defensible claim is *"highly verified community data can be collected"* — **not** *"this data will move money."*

### Resulting message architecture

| Layer | Adopts because | Notes |
|---|---|---|
| **Members** | Cards are a good way into shared resources; better privacy is a bonus | Do not adopt to generate data for anyone |
| **Organizers** | Same, plus the prospect that a healthy community becomes provable | The buyer |
| **Funders** | Not a launch audience | Parallel market-building effort |

**Structural consequence:** the organizer is the buyer but the member is the user, and the organizer must sell it to their members. The site must hand organizers something they can paste into a WhatsApp group without embarrassment. → *Deliverable for the copy plan.*

## Scope boundary (stated in Q-series 20/22)

> "I'd rather work with existing strong communities than tie this to building those communities from scratch."

Positioning consequence: **the protocol doesn't help you build a community — it gives the community you already have things it couldn't do before.**

---

## Audience candidates

David pushed back on an attempt to assign each audience a different hero capability, and the pushback is recorded as correct: **resource-sharing among people who already trust each other is the single core value; audiences vary in what kind of trust is being asserted.**

> "The club feels like the platonic use case… IF this can work for clubs/professional networks it can work for the other use cases as well. I wonder if the most learning happens there."

### Primary learning cohort

**1. Clubs** (BuildIRL orbit — political, sports, fan communities). Shared comms channel exists; sharing resources beyond it is hard. Warmest relationships, most acute pain, least money. The platonic case.

**2. Professional networks** (Integrity Institute, ACOG, etc.). Like clubs, but additionally want to know the person they're talking to has real expertise and is worth their time.

### Secondary / later

**3. National associations** (US Chamber of Connection, RSA). National networks with local chapters. Strong structural fit — national → chapter → member is exactly what delegated issuance and chain-of-trust do, and the shape other membership tools break on. May have budget to pay David to run an implementation. *(Business-model question Q19 outstanding.)*

**4. Elite networks** (SV VCs, high-net-worth clubs). Looser connections. Not values-aligned, but the data-validation → resourcing case is easiest here, and it's a route to mobilizing capital.

**5. Creators** converting an audience into an active community. *Flagged tension:* an audience is not a community — trust runs vertically to the creator rather than laterally between members, and lateral trust is what makes shared resources work. May violate the "no building from scratch" criterion. **Q22 outstanding.**

### Deferred deliberately

**6. Security-critical groups** — mutual aid networks resisting ICE, and similar. David: *"security-reliant folks are the last to approach. I'm hoping to build a bench of cybersecurity advisors to help with the Matrix implementation before moving forward, I don't expect an MVP to be highly secure."* Consistent with `capability-status.md` (dead revocation watcher, experimental Synapse join callback, contract write-integrity finding).

**7. LGBTQ youth centers, schools** — named as original inspiration; still interesting, not yet prioritized.

**8. Political campaigns** — premature for this site.

**9. AI agent identity** — commercially appealing, deliberately not a focus. Organizations or certifying bodies (bar associations, medical boards) issue cards to members; those cards issue **sub-cards to AI agents** carrying identity, basis of trust, and limited scope of authority. Would address a real problem in agentic AI, but requires cards to be an accepted identity standard first. *Branding note: nothing in the positioning should make this sound off-brand if pursued later.*

---

## Data donation flow (as described)

1. Organizer with a trusted card issues a data-donation request (e.g. "how many people from this community have you communicated with via DM or Matrix rooms?").
2. Question + query passed to a **notary service**.
3. Notary messages cardholders with the request.
4. Cardholder is prompted; if they consent, the query runs locally and produces a result (often a count) they can **preview before sending**. Response is signed by their wallet, so it's verifiably true.
5. Notary aggregates, strips identifying information, returns the signed aggregate plus a participation count.
6. Organizer has a strongly verified answer without ever touching members' personal data.

**Trust model (Q8):** notaries, like presses and relays, are trusted functions run by third parties. An operator holds a card attesting they're trusted to run one; David provides open-source (likely serverless) reference code. Protection derives from **the trustworthiness of the operator, not tamper-proof infrastructure.** This is consistent across the protocol and should be stated plainly rather than implied away — a skeptical technical reviewer will find it immediately.

**Status:** not in the five near-term capabilities, not in `capability-status.md`. Mostly a frontend feature per David. Should appear in messaging as a clearly-labelled direction, not a current capability.

---

## Movement ecosystem — all warm relationships (Q14)

David confirms warm relationships with **all** organizations cited in the Substack post:

BuildIRL · Aspen Weave · Foundation for Social Connection · Connective Tissue · the Interstitium · US Chamber of Connection · Relational Technology Project · Relational Design Lab · Donor Organizer Hub

Plus: Integrity Institute (former colleagues), Substack subscribers, monthly Relationality Lab gatherings, book club network.

**Implication for Phase 5:** the promotion plan was scoped assuming cold outreach through a personal network. That's wrong. This is an **ecosystem activation** problem with warm entry points and an audience already self-selected for the thesis. Phase 5 should be rewritten accordingly.

*Note: BuildIRL is winding down for lack of funding; David and others are attempting to convene grassroots gatherings of club builders.*

---

---

# Session 2 — 2026-08-15/16

## The crux answer (Q23) — a card is worthless without a paired service

> "The membership card gives you access to things, so the rollout would need to be paired with something that people want access to. Maybe that's a shared calendar. Maybe that's a leaderboard for tracking run distance. Some of the infrastructure it comes with (messaging, group chat) is duplicative of WhatsApp, so we don't expect that to be a compelling offer at first."

Rollout therefore assumes someone — likely David — has worked with the organizer to design a service compelling enough to justify adoption. **What that service should be is the single biggest unknown, and discovering it is a primary purpose of the site.**

On software builders as an audience: they *are* one, but **not to be centered** — "prototyping/adapting open source technology is fairly cheap in an era of AI coding." Center people building clubs, not people building software.

### Consequences

1. **First wave is concierge, not self-serve.** A handful of deep engagements, not a funnel. **Site success = ~5 excellent fits, not signup volume.**
2. **The site should qualify hard**, closer to an application than an email capture, and should open with the discovery question: *what would your community share if it were easy?*
3. **Confirmed by David (Q25):** *"This is an organizing play."* He'll convene regular meetings of allies to recruit volunteers who can support high-touch onboarding as it scales — charging in some cases, pro bono in others. **"This should be relational rather than feeling like SaaS."**
4. **Menu of example services (Q26): yes** — shared calendar, run leaderboard, free-stuff list, mutual aid board, members-only Minecraft server — *"so long as it's clear that these are hypotheticals rather than current offerings."* Does triple duty: explains value, prompts self-recognition, and collects "none of these, but here's what *we'd* want."

## Community sniff test (Q24)

Qualifies as a candidate if:
- Recurring meeting with regular attendees, **and**
- An existing shared channel.

Bonus, not required: already shares childcare or practices collective care in some form. *"Part of the goal is to get them there."*

→ Becomes the self-qualifying language on the site.

## Creators (Q22) — deferred, with two viable sub-segments

Not an initial audience. Down the road, appealing: David would like to convene a network of organizers paired with creators and other audience-holders to build active communities.

Two creator sub-segments that *do* have lateral trust and are worth engaging:
- Creators already organizing around **causes** (e.g. Social Current).
- Creators **coordinating with each other via backchannels** to amplify political content — the protocol could become a home for those backchannels.

## Objections (Q27–29)

**The two real objections:**
1. *"We don't need another identity protocol."* Many identity and messaging protocols already exist — what's unique here?
2. **Switching costs.** *"In communities, people stick to the tools they know. WhatsApp is the standard not because it's good but because it's familiar."*

**Answer to 1 — accepted reframe:** identity is the *mechanism*, not the point. This is about what a community can share once it knows who it is. The comparison class isn't Sign-In-With-Whatever; it's the duct-taped stack of WhatsApp + spreadsheet + Eventbrite + GoFundMe.

**Answer to 2 (Q31) — communities don't switch, they add.** Cards are adopted for what WhatsApp can't do. David: switching may come later, first for a leadership core, then more broadly — and switching is what unlocks the richer data possibilities. But that requires broader adoption first. Matches the Desiree story, where the tech collective sets her up *on* WhatsApp rather than moving her off it.

**Answer to 3 (why be first):** for first adopters the benefit is **shared resourcing**. Target people for whom moving from WhatsApp/Discord to a set of shared resources is compelling on its own. Data, cross-community trusted messaging, etc. come into play only as more communities join.

## The governing brand constraint (Q28) — technology cannot be the protagonist

> "There's some sourness around a software solution in general. People are rightly skeptical of tech, they want paths forward for community that are rooted in resourcing and in lineage and are wary of technosolutionism… An alternative approach is needed that acknowledges this as software but doesn't make technology the protagonist."

**Refined in Q30: the problem is not technology, it's *technocolonialism*.**

- **Resemble:** Signal — a nonprofit run by movement hackers.
- **Avoid resembling:** OpenAI, Anthropic, Meta, and other billionaire-led tech giants.
- Federation means power doesn't aggregate to a central company; strong privacy is a reaction to surveillance capitalism; the goal is living wages, not another billionaire.
- *"That's not the thing to center, but ideally those values come through."*

**Consequence for step 1.4:** reference-site research should be rescoped away from protocol/tech sites toward **organizing and movement sites**, with **Signal as the anchor** and big-tech sites as cautionary examples.

## Pre-launch register and demo (Q32–33, Q35)

**Honest framing, David's words:** *"This is in development, and I'm looking for partner communities to develop it with. They'll get a high-touch relationship that shapes this around their needs."*

**Timeline:** frontend prototype in **1–3 months** depending on complexity, now that the backend is live. Could be white-labeled. Meaningful technical problems remain, but it's largely a matter of piping data from `app-sdk`/`wallet-sdk` into a frontend UI.

**What's demonstrable today:** David can create a card and give it to someone — laborious, and the recipient can't do anything with it. In conversation, **showing the architecture to help people imagine what's possible has resonated**, which argues for the site explaining the architecture visually.

**Possible demo:** a basic UI where people hold cards and converse with them — *"get a card that makes you feel special, get a message with it, and see a shared resource."* **David does not want to gate the static site on this existing.**

**Dogfooding idea (Q35, raised by Claude, David receptive):** David wants to build a community of people building the protocol. That community is itself a candidate first card-issuing community — solving cold-start, producing a real rather than hypothetical demo, and requiring no outside community to take a risk. *Awaiting David's final read on whether this pulls focus from the organizer audience.*

## Assurances (Q34) — deferred to its own phase, by David's request

> "The core assurances (different than the core features) are a list I want to develop, carefully word, test against the implementation and then advertise and invite scrutiny around from cybersecurity professionals."

Treated as **step 2.1**, not compressed into the interview. Draft promises offered as input:

1. When you show someone a card, they know with certainty **why it was given and by whom** — each card carries a chain of verification establishing why the holder is trustworthy.
2. Cards can be **appended, updated, and revoked** — so a card you're shown reflects current standing.
3. A card reveals **why you're trustworthy and nothing else** (e.g. "employee at Anthropic," otherwise anonymous) — unless the issuer chose to include PII.
4. Cards represent **isolated parts of your identity**. A "Trusted Pediatrician" card and an "Unhinged Metal Fan" card cannot be linked unless you show them together.
5. Cards confer **trust and accountability**. An anonymous holder who misbehaves can still be reported to their issuer.
6. Cards are **private** — infrastructure operators cannot track which cards you hold or how you use them.
7. Cards are **decentralized** — federated infrastructure, anyone trusted can run part of it; no single company or billionaire holds power over it.
8. Cards are **secure** — post-quantum key material, encrypted messaging, resistance to man-in-the-middle, and a foundation for community-level data ownership.

**Explicitly not promises:**
- Not a turnkey SaaS solution for enterprise.
- Cards cannot build a community for you — they must be paired with skilled organizing.

### Flags raised against the draft (carry into 2.1)

- **#8 wording is wrong as drafted.** ML-DSA-44 is a signature algorithm and encrypts nothing. Correct split: ML-DSA-44 signs, ML-KEM-768 encrypts, secp256r1 authorizes on-chain writes (classical, with migration path). Spec already pins ML-KEM-768 — see the TODO section in `capability-status.md`. **David's decision: mark as TODO, proceed with the post-quantum messaging assurance.**
- **No forward secrecy yet** (MSG-OQ-3a) — static ML-KEM key means captured ciphertext is retroactively decryptable if the key is compromised. Matters especially because the brand aims at Signal.
- **#2 is the weakest promise against current code.** `appendLogEntry` hasn't adopted the spec's `card_state`/`history` design (`version` hardcoded to 1, "placeholder for Phase 3"), and the Matrix revocation watcher is built but never started. Revocation carries the accountability story and has the largest claim-to-code gap.
- **#6 is a strong global claim** that will attract scrutiny. Better phrased as what each component *cannot* see than as a blanket guarantee.

---

## Session 2 addendum — method decisions

**1. Assurances are stated as design guarantees, then tested against.** David: *"I would like to assert this claim and then test against it. Having clear, easily understood claims that we then assess the protocol against is part of the project here."*

This is a security-claims-document methodology, and it's more honest than hedging — **conditional on the testing actually happening and its results being published.** Presentation discipline: assurances are what the protocol is *designed to guarantee and is being audited against*, not what has been independently verified. Consistent with the site's pre-launch register.

**2. Don't itemize build state in high-level marketing.** David: *"The gaps around revocation are known and will be resolved in parallel. No need to get specific in high level marketing about what has been built now and what is still in process if we know it's possible."*

Assurance drafting therefore **assumes the revocation gap is closable** and states the guarantee. Detailed build status stays in `capability-status.md` for internal use and for technical readers who go looking — it does not drive headline copy. *(This supersedes the earlier Goal 2b objective requiring a per-assurance build-status label on the site itself.)*

**3. Dogfooding is helpful but insufficient (Q35).** David: *"That community needs to be motivated by other people using it. So the site needs to appeal to people other than those who want the protocol to exist for its own sake, though it can include calls to action to get involved."*

→ The site carries **multiple constituency-specific CTAs** — community builders (primary), cybersecurity expertise, contributors — without letting the builder audience displace the organizer audience.

---

## Still outstanding

- **Q19.** Is a paid implementation for a national association the business model or a side effect? *(Partially answered in Q25 — charges sometimes, pro bono others — but the site's role in generating that inbound is unresolved.)*
- **Q12.** Size and engagement of the Relationality list; willingness to use it for this.
