# Explainer Video Plan — membershipcard.io

*Drafted 2026-09-26. Governed by `branding/brand-guide.md` (voice, terminology) and `branding/assurances.md` (every claim must trace to an assurance). Copy source: `mcard_landing/_data/home.yml`.*

---

## Goal

A ~90-second explainer that lets a non-technical community leader (a pastor, a salsa club organizer, an LGBT center coordinator) answer three questions:

1. **What is a membership card?**
2. **What would my community do with one?** — get into community resources and spaces; prove affiliation to others.
3. **Why should I trust it?** — it's private, and it's run by a network of trusted operators rather than a large tech company.

**Success test:** after one viewing, an organizer can explain it back in a sentence like *"We give our members a card, and they use it to get into our stuff and to show they're one of us — and nobody's watching."*

## Deliverables

| Output | Spec | Use |
|---|---|---|
| Script | [explainer-video-script.md](./explainer-video-script.md) | Review & approval before style frames |
| Master | 16:9, 1080p, ~90s, burned-in captions + `.srt` | Site hero, YouTube, presentations |
| Social cut | 9:16, ~45–60s, captions burned in | Bluesky, Instagram, WhatsApp forwards |
| Poster frame | PNG | Embed thumbnail |

Captions are required, not optional: most social autoplay is muted, and it's an accessibility baseline (`mcard_landing/ACCESSIBILITY.md`).

---

## Creative approach

**Style: flat 2D motion graphics built from the site's existing assets.** It's cheap, it's consistent with the site, and it's easy to revise when the copy changes.

- **Palette:** Green 800 `#1d741b`, Green 600 `#5eb229`, Green 200 `#d2fba4`, Coral 500 `#ff6260` (sparingly, for the "tap/show card" moments), white background. Per `branding/color_palette.md`.
- **Reused assets (`mcard_landing/img/`):** the five community card faces (Waterfront Salsa Society, LGBT Center Youth Group, Neighborhood Mutual Aid Network, Gospel Choir, Tech Workers for Climate Action), the eight resource icons (calendar, checklist, pickaxe, ballot box, car, folder, hammer, clothes), and the three how-it-works illustrations (`step1-handoff`, `step2-car`, `step3-tap`).
- **Recurring visual motif:** a card that slides out of a phone wallet and gets *dragged onto* a door, app, or message. This matches how presentation really works (`home.yml` step 3), and it's the one gesture viewers should remember.
- **Protagonist:** one organizer, introduced by name, who runs the **Waterfront Salsa Society**. That's concrete before abstract (brand voice principle 1). The other card faces show up in the privacy scene to suggest one person holding several cards.
- **Tone:** warm, plain, unhurried. No exclamation marks, no "unlock the power of community" (brand voice principle 6).

### Language guardrails (from the brand guide)

- **Never on screen or in VO:** blockchain, crypto, Web3, token, wallet address, smart contract, on-chain, decentralized, trustless.
- **Say:** "card" (not credential or badge), "the people in your community" (not users), "run by many independent operators," "private by default," "cryptographically verified."
- **Wallet:** "the card wallet on your phone" is fine. It's the site's own phrasing and reads like Apple Wallet, not crypto.

### Accuracy guardrails (from assurances + project status)

These claims are easy to overstate. The script below is worded to stay inside them:

| Claim in brief | What we can actually say | Source |
|---|---|---|
| Prove affiliation on Bluesky | **Cut for now** (decided 2026-09-26). Bluesky isn't shipped yet. | `home.yml` step 3 |
| Operators | Approved framing: "run by a network of trusted operators rather than a large tech company." | A9 |
| Private | "**No single operator** can see who holds a card or what they do with it." Don't say "no one can ever see anything." | A8 |
| Reveals nothing else | "In most cases" shows up on the site. The VO can say "proves you belong, and nothing else," but the visuals shouldn't imply full anonymity. | A3, `home.yml` pillar 2 |
| Cards aren't linked | "Your cards aren't connected to each other." | A4 |
| It's ready | The front-end app isn't built yet. Close on "in development, looking for community partners." | `home.yml` honest statement, voice principle 3 |

---

## Script & storyboard

Moved to **[explainer-video-script.md](./explainer-video-script.md)**, which is the editable source of truth for review and approval.

**Social cut (9:16, ~50s):** Scenes 1 → 3 (trimmed) → 4 → 5+6 merged → 7.

---

## Production pipeline

**Recommended tooling: [Remotion](https://www.remotion.dev) (React → MP4) plus ffmpeg (already installed).** The whole video lives as code in a repo. Claude can build and revise scenes directly, reuse the site's PNGs and palette, re-render when copy changes, and output both aspect ratios from the same components. The alternatives are Canva (easier for non-developers to tweak, harder to keep in sync) or a freelance motion designer (highest polish, roughly $1.5–4k).

| # | Step | Output | Owner |
|---|---|---|---|
| 1 | **Lock the script.** Read it aloud and check every line against the accuracy table above. | Final VO script | David |
| 2 | **Style frames.** Render one still per scene in Remotion to approve the look before animating. | 7 PNGs | Claude |
| 3 | **Scratch voiceover.** Use TTS (macOS `say` or ElevenLabs) only to get real timings. | `vo_scratch.wav` + word timestamps | Claude |
| 4 | **Animate.** Build one Remotion composition per scene from shared components (`CardFace`, `PhoneWallet`, `DragToTarget`, `IconOrbit`, `VerifyChip`, `OperatorNetwork`), timed to the VO. | 16:9 draft render | Claude |
| 5 | **Final voiceover.** Record in David's voice (the brand voice "already exists in David's writing") or use a warm human VO artist. A quiet room and a USB mic are enough. | `vo_final.wav` | David |
| 6 | **Music + mix.** Use a soft, royalty-free acoustic or ambient bed with music ducked under the VO. Normalize loudness to about −14 LUFS for social. | Mixed audio | Claude |
| 7 | **Captions.** Generate the SRT from the script and timestamps, then burn in a captioned version. | `.srt`, captioned MP4s | Claude |
| 8 | **Render.** Produce the 16:9 master, the 9:16 social cut, and the poster frame. | Final files | Claude |
| 9 | **Test with 3 organizers.** Show it once, then ask them to explain it back. Fix whatever they get wrong. | Revision notes | David |
| 10 | **Publish.** Embed on the site (hero or just above "How It Works"), post on Bluesky, upload to YouTube. | Live | David |

**Proposed location:** a new `mcard_landing/video/` Remotion project, so the video ships next to the assets and copy it depends on.

---

## Decisions

- **Bluesky:** cut for now (2026-09-26).
- **Operator framing:** "run by a network of trusted operators rather than a large tech company" (2026-09-26).
- **Next step:** David reviews and approves the script, and only then do we render style frames.

## Open decisions

1. **Voice:** David's own voice (recommended) or a hired VO artist?
2. **Protagonist:** keep "Desiree / salsa society," or pick a setting closer to the first partner communities (church, LGBT center)?
