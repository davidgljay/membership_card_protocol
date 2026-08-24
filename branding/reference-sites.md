# Reference Sites

*Phase 1.4 deliverable, 2026-08-16. **Rescoped** per the Q28/Q30 finding: technology cannot be the protagonist, and the objection is technocolonialism rather than technology. Research therefore targets movement, organizing, and nonprofit-tech sites, with Signal as the values anchor and commercial community platforms as cautionary examples.*

**David picks 1–2 to inform the design.**

---

## Recommended pair

### ⭐ 1. Rhizal — rhizal.chat
**Your own site. The structural template.**

You have already solved this exact problem: a pre-launch, alpha, invitation-only, open-source community tool from Relationality Lab that is honest about incomplete security and recruits partners through a high-touch application. Every structural constraint the card site faces, Rhizal already answers.

**Structure worth reusing wholesale:**

| Rhizal section | Why it works here |
|---|---|
| One-line definition under the logo — *"A lightweight tool for building community on Signal"* | Concrete, humble, no mission language before the reader knows what it is |
| **"Try It Out — send a message to @rhizal.15"** | An immediate, zero-commitment way to touch the thing. The card equivalent is the demo question (Q33). |
| Five feature blocks, each: illustration + heading + 2–3 short lines | Exactly the "menu of hypothetical services" pattern from Q26 |
| "Who's Behind Rhizal?" — open source, Relationality Lab, **alpha, by invitation only** | Honest pre-launch register in three sentences |
| Explicit security limitation, stated plainly, followed by "we will work with potential partners to ensure their security needs can be met" | The model for how to state incomplete security without either hiding it or scaring people off |
| Two-stage form: email capture → then Name / Organization / Message | **The high-touch qualifier from Q25.** Low-commitment entry, higher-intent second step. |
| FAQ answering the hard questions directly, including "what are the limits to its security?" | Where technical honesty lives without cluttering the main narrative |
| Two setup paths: apply for concierge support, or fork the repo | Serves organizers and contributors without letting builders take over the page |

**What to change:** Rhizal's feature blocks describe things that exist. The card site's menu is hypothetical and must be labelled as such. Rhizal also leads with mechanism ("a tool for building community on Signal"); the card site needs a beat of *why* before *what*, because the card idea is less immediately familiar than a chatbot.

**Bonus:** using your own house pattern makes the two products visibly siblings — reinforcing that this comes from a body of work rather than out of nowhere.

---

### ⭐ 2. Signal — signal.org
**The voice and values anchor.** Named by David as the thing to resemble: a nonprofit run by movement hackers.

**What to steal:**

- **Plain declarative headings, no jargon.** "Speak Freely." "No ads. No trackers. No kidding." Zero technical vocabulary above the fold, despite being one of the most cryptographically serious products in existence.
- **Values stated as facts about the organization, not as ideology.** *"Signal is an independent nonprofit. We're not tied to any major tech companies, and we can never be acquired by one either."* Two sentences do what a manifesto couldn't. This is the model for expressing the anti-technocolonialism position — as structural fact, not as argument.
- **Privacy framed as a default, not a feature.** *"Privacy isn't an optional mode — it's just the way that Signal works."* The card equivalent: cards don't have a private mode; they're private.
- **Crypto mentioned once, in passing,** with a link out. "State-of-the-art end-to-end encryption (powered by the open source Signal Protocol)" — then straight back to what it means for you.
- **The whole page is short.** Six sections. Nothing is over-explained.

**What to avoid:** Signal is a finished consumer product with a download button. The card site has neither, so it can't borrow the confident-launch posture — that's what Rhizal's register is for.

**Caveat worth holding:** if the site invokes Signal-like security, expect Signal-informed scrutiny — including the forward-secrecy question flagged in `capability-status.md`.

---

## Also analyzed

### 3. Relationality Lab — relationalitylab.org
**House style and the parent brand.** Full-bleed photography of real gatherings, a first-person voice, three "What I Do" blocks, and a "Core Beliefs" section carrying the argument. The photography choice matters: real people at real gatherings, not product screenshots or abstract network diagrams. **Steal:** the photographic register, the first-person warmth, and the belief-statements-as-section-headers pattern. **Note:** the card site should feel like it belongs to this family without being a clone — it's a protocol, not a personal practice.

### 4. Mastodon — joinmastodon.org
**The best mainstream example of explaining federation to non-technical people.** *"Social networking that's not for sale."* *"Instant global communication is too important to belong to one company."* Decentralization is framed entirely as a power question, never as an architecture question — which is precisely the sushi argument in different clothes. **Steal:** the "Why Mastodon?" four-icon row (Decentralized / Open Source / Not for Sale / Interoperable) as a model for compressing structural values into scannable claims. **Avoid:** the testimonial wall (you have no users yet) and the sponsor logo grid, which has aged badly and undercuts the independence claim.

### 5. Weave: The Social Fabric Project — weavers.org
**The movement register, and a cautionary tale.** Aspen Institute, founded by David Brooks. Opens with the crisis framing and statistics (58% of Americans say they are lonely), then names and celebrates "weavers." Warm relationship, adjacent audience, similar thesis. **Steal:** naming the audience so they recognize themselves — *"You probably know some of them… You may be one of them."* That's the self-recognition move the qualifying test needs. **Avoid:** the site is almost entirely program-listing with no concrete offer; a reader who wants to *do* something has four newsletters to choose from. The card site must not become a list of initiatives.

### 6. Mighty Networks — mightynetworks.com
**Cautionary example. This is the register to define yourself against.** *"Our Hosts earned $500M in 2025."* An ROI calculator. "The $48 membership." Community reduced to a revenue funnel, with organizers renamed "hosts" and members renamed conversion. It's competently built and it will be in your reader's peripheral vision — several club builders have evaluated exactly this category. **Useful because:** the contrast is your positioning. Where Mighty says *monetize your audience*, the card protocol says *your members build things for each other*. Where Mighty owns the platform and the data, cards are federated and the community owns the data. **One thing worth stealing:** its FAQ-as-section pattern ("What do I build first?" "How much time does it take?") anticipates real objections in the reader's own words.

### 7. Relationality book site — relationalitybook.com
Included as house-style reference. Blurb-forward, clean, single-purpose. **Relevant mainly as a source of credibility assets** (North Atlantic Books, Andrew Solomon, Lennon Flowers) that can appear on the card site's about section, and as evidence of the visual family the new site should join.

### 8. Legacy `landing_page/` in this repo
Superseded, but worth one look: it's a Bootstrap one-pager in the same lineage as relationalitybook.com and relationalitylab.org. If the new site is built fresh in Jekyll without Bootstrap and jQuery, it should still read as a sibling of that family — warmer typography and full-bleed photography, not a framework reset.

---

## Recommendation

**Rhizal for structure, Signal for voice.** They divide cleanly and neither fights the other:

- **Rhizal** supplies the skeleton: definition line → try-it hook → hypothetical service menu → who's behind it → honest limitations → two-stage qualifying form → FAQ. It is already proven against this exact set of constraints, and reusing it makes the two projects visibly related.
- **Signal** supplies the register: short declarative sentences, values expressed as structural facts, cryptography referenced once and then dropped, and total absence of jargon above the fold.

Add from the others selectively: Mastodon's four-icon values row, Weave's self-recognition phrasing, Relationality Lab's photography of real gatherings, and Mighty Networks as the thing to sound nothing like.

---

## Decisions (David, 2026-08-16)

**Selected: Rhizal for structure and style, Signal for voice.** With four modifications:

1. **Colour comes from `color_palette.md`** — the deep teal + warm sand direction, which sits closer to Relationality Lab than to Rhizal's own palette. Rhizal supplies layout and structural pattern, not colour.
2. **"A project of Relationality Lab" displayed prominently above the header.** Parent-brand attribution is explicit and immediate, not relegated to a footer.
3. **Three destinations, not one scroll.** Resolved 2026-08-16: a **landing page** (club builders), a linked **assurances page** (the register), and the **GitHub repository** (architecture, carried in the README). No separate developer page — the repo is the developer page. This lets the landing page stay short, since anything conceptually heavy has somewhere else to live. See `brand-guide.md §Structure`. Whether the landing page itself needs sub-pages or disclosure sections is still for the wireframes (3.1).
4. **Rhizal itself is a candidate onboarding channel** for volunteers, given some upgrades.

### Implication for step 4.2 (email capture)

If Rhizal handles volunteer onboarding, the site's CTA could run through **Signal rather than a form** — mirroring Rhizal's own *"send a message to @rhizal.15."* Worth weighing seriously:

- **For:** a privacy-respecting CTA that matches the values rather than contradicting them; no third-party email vendor holding a list of community organizers; it dogfoods Relationality Lab's own tooling; and it's a channel David controls end to end.
- **Against:** requires Signal installed, which is a real filter on club builders (per the Substack post, most WhatsApp users won't switch); harder to nurture with periodic updates; and it makes the low-commitment entry step higher-friction than an email field.

**Likely answer: both.** Email for the low-commitment "keep me posted" tier, Signal/Rhizal for the higher-intent partner conversation — which maps cleanly onto Rhizal's own two-stage form pattern. To be settled in 4.2.
