# Card Design Guide

## The Core Metaphor: Physical Cards

Mark Protocol cards are modeled on **physical membership cards** — a library card, a union card, a guild card. The visual language should evoke something you'd keep in a wallet: a rectangular card with rounded corners, a solid or branded background, and an issuer's mark on it.

**Cards are not badges, icons, or hexagonal tiles.** Any existing references to displaying card images in hexagonal frames should be updated. The card image field holds an image of the card itself (e.g., a branded card face designed by the issuer), not an avatar or logo in a shaped frame.

---

## Card Stack: Collapsed View

When a user holds multiple cards, they are displayed as a **stacked deck**, similar to Apple Wallet. The stack sits in the wallet view with cards fanning out or layered behind one another.

### Collapsed state
- Only the **top card** is fully visible.
- Each card behind it peeks out slightly at the bottom, showing its dominant color or a thin strip, so the user can sense how many cards they hold.
- The **icon or logo of the issuing organization** sits prominently in the upper portion of the visible card face, serving as the at-a-glance identifier.
- Card name (e.g., "Queer Youth Group Member") appears beneath the icon in a clear, legible typeface.
- Status indicators (e.g., a small green checkmark for valid, grey for revoked) appear as a subtle overlay on the card corner — not obstructing the card face.

### Visual hierarchy in collapsed state (top to bottom)
1. Issuer icon / logo
2. Card name
3. (Optional) short tagline or community name
4. Status indicator (corner)

---

## Individual Card: Expanded View

Tapping a card (or pulling it from the stack) expands it to reveal full information. The expanded card still looks like a physical card — it does not transform into a form or list view. Additional information lives *on the card face* in structured fields.

### Expanded card face (front)
- **Top band**: Issuer icon + issuer name
- **Card body**:
  - Card name / title (large)
  - Holder identifier (anonymized by default — e.g., "Card #4f2a" or a user-chosen display name)
  - Validity period (if set)
  - Card image, if provided by issuer (a branded graphic filling a portion of the card face, like a custom card design)
- **Bottom band**: Status badge + issue date

### Expanded card detail (revealed below or on card flip)
Tapping further or flipping the card reveals:
- Issuer chain summary (who granted this card, and their trust lineage)
- Notes / endorsements appended to the card (achievements, flags)
- Update history (visible codes in the 200 range; revocation detail if applicable)
- Actions: Share, Report, View Lineage

---

## Card Image Field

The `image` field in a card's metadata document holds a **CID pointing to an image of the card face itself** — a branded graphic designed by the issuer, much like the design printed on a physical card. Issuers may provide:

- A solid color with a logo
- An illustrated card design representing their community
- A photo or texture background with overlaid text

This image is displayed on the card face in the expanded view, and may tint or influence the card's color in the collapsed stack view.

**This is distinct from the issuer's icon/logo**, which is a separate, smaller asset used in the collapsed stack header.

---

## Corrections to Earlier Documentation

The following raw notes contain references to displaying card images in a **hexagonal frame** that do not reflect the intended design direction. These should be updated to reference the physical card metaphor:

- `raw_notes/Badge Architecture Overview.md` — line 22
- `raw_notes/Card Creation.md` — line 45
- `raw_notes/Naming Convention.md` — line 40

In all three cases, replace language like "intended for display in a hexagonal frame" with language reflecting that the image is the card face graphic, displayed on the card itself.

---

## Design Principles

**Familiar.** Cards should feel like something people already know — a wallet full of cards. No new mental model required.

**Legible at a glance.** The issuer icon and card name must be identifiable without tapping. Stack depth should be visually apparent.

**Private by default.** The collapsed stack reveals nothing about card content to someone glancing at a screen. Expansion is an intentional act.

**Trustworthy, not flashy.** Visual design should communicate legitimacy and stability, not novelty. Think credit card or transit card, not a collectible NFT.
