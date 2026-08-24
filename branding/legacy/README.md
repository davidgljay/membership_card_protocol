# Legacy Branding Material

The files in `branding/` marked "Superseded 2026-08-10" (`dnp_overview.md`, `technical_overview.md`, `card_design_guide.md`) predate the current name and architecture decision (see `../strategic-plan.md`). They are retained for reference, not as source material to copy from directly.

## What's reusable

- **`dnp_overview.md` — the Taryn/Fatima narrative.** This is the most valuable surviving asset in the legacy material. It explains the protocol entirely through story, with no cryptography jargon, and already models the plain-language register the new brand needs. Mine it for scenario ideas and tone, not for terminology (it still uses "badges" and "DNP").
- **`color_palette.md` — not superseded.** This is a live candidate for the protocol's visual identity (Deep Teal + Warm Sand) and should be treated as current working material, not legacy.

## What's not reusable

- `technical_overview.md` — uses the "Digital Neighborhood Protocol" name and "badge" terminology throughout; architecture description predates the current stack.
- `card_design_guide.md` — uses the "Mark Protocol" name; core physical-card metaphor may still be valid but needs revalidation against the new brand guide.

The original `landing_page/` Jekyll site is not carried forward. The new site is built fresh in the separate `mcard_landing` repo per strategic-plan.md Decision 6.
