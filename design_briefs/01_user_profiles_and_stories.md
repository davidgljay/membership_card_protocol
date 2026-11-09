# Design Brief 01 — User Profiles and Stories

**Status:** Draft, still needs interviews to confirm
**Date:** 2026-10-23
**Source:** `raw_notes/User Profiles and Stories.md`, expanded against `specs/card_protocol_spec.md` (v0.4), the process specs, `specs/messaging_protocol.md`, `specs/subcards.md`, `specs/key_rotation.md`, and the mutual-aid PRD (`specs/mutual_aid_mvp.md`)
**Next briefs:** 02 Journeys & priority flows · 03 Vocabulary & information architecture · 04 Visual direction

### How to read this

- Text marked *(assumption)* is my extrapolation. Check it in an interview before designing on it. Everything else comes from the raw note or the specs.
- Each story has a tag: **[O]** original story, kept · **[R]** original story, rewritten or split · **[N]** new story, taken from the spec (with a section reference).
- Story format: *As a …, I want … so that …*, followed by design notes. The notes say what the protocol actually does, so the UX doesn't promise more than it can deliver.

---

## 1. Personas

| | Persona | Tier | Main protocol roles |
|---|---|---|---|
| P1 | Club Leader | Primary | Policy administrator, issuer, revoker, announcer |
| P2 | Club Member | Primary | First-time recipient, holder, message recipient |
| P3 | Mutual Aid Leader | Primary | Administrator of several policies, delegator, auditor, revoker |
| P4 | Mutual Aid Participant | Primary | Holder, messenger, authenticator; security-conscious |
| P5 | Steward / Co-organizer | Secondary *(new)* | Delegated issuer, limited revoker |
| P6 | Resource Owner / Integrator | Secondary *(new)* | Owns a website, room, or service that accepts cards |

**Out of scope for the frontend for now:** press operators, the Root Policy / DNS / Press Registry governance bodies, and app certifiers. These are infrastructure roles. They will still need admin tooling later, but they aren't the audience for the community-facing frontend.

---

### P1 — Club Leader ("Marco")

**Snapshot.** Runs a local salsa club. Uses WhatsApp and Squarespace every day and isn't otherwise technical. The club talks in a WhatsApp group, and he wants to add resources on top of that without replacing it.

**Context**
- Club size is roughly 30–150 people, with turnover every season *(assumption)*.
- WhatsApp is where everything happens. Squarespace hosts the class schedule and event pages.
- He does admin on his phone, with a laptop now and then *(assumption)*.

**Goals**
- Give members something that feels like belonging, such as perks, access, or recognition, without it turning into homework.
- Gate member-only resources: a members page, discounts, a practice playlist, a members' chat *(assumption: which resources come first)*.
- Know who's in, and quietly remove someone who causes problems.
- Reach members in a channel he controls.

**Frustrations and fears**
- A setup that eats a weekend.
- Jargon: keys, chains, presses, policies.
- Making a mistake he can't undo, such as revoking the wrong person or posting a link with no limits.
- Members ignoring the whole thing.

**What the protocol asks of him** (this is the gap the design has to close)
- A *policy card* is issued to him by an *authorizer* and operated by an *approved press* (§1). For a new trust anchor it also needs a Root Policy Governance Body bootstrap (`policy_creation.md` Phase 0). Marco will not do any of this himself, so a hosted service has to play those roles behind the scenes. See tension T1.

**Design implications**
- Every protocol concept needs a plain-language name, for example: policy → "card type", open offer → "invite link", press → invisible, revocation → "remove from club".
- Start from templates, not blank forms. A "Club membership" template with sensible defaults gets him to a live invite link fastest.
- Actions that can't be undone (revocation, an invite link with no limits) need a confirmation that spells out the consequences in plain terms.
- The most important output is a link shared into WhatsApp, so the share sheet and link preview text matter a lot.

**Success looks like:** about 30 minutes from start to a live invite link posted in WhatsApp, with the first claims coming in (the target in the mutual-aid PRD).

---

### P2 — Club Member ("Lena")

**Snapshot.** A member who receives a card from Marco. She'll spend a small amount of time on it and move on. If it intrigues her, she may come back to check club notifications in the wallet.

**Context**
- Smartphone-first; lives in WhatsApp and Instagram.
- Has never used a crypto wallet. May already have a synced passkey (iCloud or Google) without knowing the word *(assumption)*.

**Attention model**
- She is only guaranteed one session. Whatever value the card has must show up on the post-claim screen.
- After that, she comes back only because of notifications, so the notification-permission moment and the first message carry real weight.

**Goals**
- Get the perk or access quickly.
- Avoid creating another password.
- Answer two questions at a glance: "Is this really from Marco's club?" and "Is this safe?"

**Fears**
- Scams and phishing ("is this a crypto thing?").
- Handing over her phone number or email.
- Spam.

**Design implications**
- The claim flow is one understandable screen, then passkey creation framed as "save to your phone".
- Use named progress states such as "Creating your card…" (spec §4 P1), never a blank spinner.
- Avoid crypto and web3 visual tropes entirely.
- A "What your card unlocks" screen right after claiming is the hook.
- Ask for notification permission only after she has seen that value.
- Recovery defaults to a synced passkey, with a light one-line explanation.

**Success looks like:** the card is claimed in under 5 minutes (PRD target), and she sees at least one concrete thing she can do with it.

---

### P3 — Mutual Aid Leader ("Rosa", they/them)

**Snapshot.** A leader in a mutual aid network. They have many resources to set up and are deeply concerned about digital security and privacy.

**Context**
- The network may serve people at elevated risk, such as immigrants, unhoused people, or organizers *(assumption)*.
- Fears infiltration, doxxing, and legal compulsion *(assumption)*.
- Already uses Signal.
- Runs sub-groups such as drivers, food distribution, a fund committee, and neighborhood pods *(assumption)*.

**Goals**
- Create several card types (member, driver, steward, fund approver) and delegate issuance to trusted people.
- Gate several resources: rooms, a fund-request flow, shared documents.
- See the vouching chain: who brought whom in.
- Revoke fast if someone turns out to be an infiltrator, without harming someone who was revoked in error.
- Keep as little data about members as possible.

**Concerns**
- Metadata exposure: what the wallet service, relay, press, Matrix operator, and chain can each see.
- Who can see the member list.
- Losing keys.
- The reputational weight of a "loud" (9xx) revocation, which can follow a person into other communities.

**Roles in the protocol**
- Administrator of several policies.
- Issuer and delegator.
- Auditor (`log_auditing.md`).
- Revoker, including 9xx.
- Room creator.
- Possibly a self-hosted press *(assumption)*.
- Likely YubiKey user.

**Design implications**
- A "who can see this" explainer at each sensitive action, a kind of privacy ledger. The specs already document most of what each party can see (wallet service, relay, Matrix operator, chain), so the content exists.
- Steer toward targeted offers. The spec itself says an open link is only as secure as the channel it travels through (§2, open offer flow step 3). The UI should say this plainly.
- Advanced controls should be reachable but not on by default: auditors, `revocation_permissions`, notification suppression, backdated effective dates, M-of-N approval.
- A delegation tree showing who can issue what, and who issued whom.
- Encourage YubiKey backup, and set up recovery notification channels clearly.

**Success looks like:** Rosa can confidently answer three questions: who is in, who vouched for them, and who can see what.

---

### P4 — Mutual Aid Participant ("Dev")

**Snapshot.** A participant in the network. Cares about security and wants something that just works. Distrusts mainstream tech products but finds them familiar and is uncomfortable switching.

**Context**
- Possibly an older or shared phone, limited data, and inconsistent connectivity *(assumption)*.
- Keeps using WhatsApp and Gmail despite misgivings.

**Goals**
- Ask for or offer help without exposing their identity broadly.
- Receive network messages reliably, and know they really came from the network (protection against impersonation).

**Fears**
- Being identified or tracked.
- Losing access.
- Having to learn a new app.

**Design implications**
- Familiar patterns: an inbox and contacts, not a "wallet".
- Works in a browser or PWA first (the PRD's direction).
- The verified-sender mark on every message is the core value, and it has to read as a simple "this is really from them", not as jargon.
- Plain-language answers to "what does the network learn about me?"
- A clearly signposted path for a lost phone.
- Behaves well on slow connections. Verification needs chain and revocation fetches (§7), so design cached and stale states (spec: "stale revocation data is flagged").

---

### P5 — Steward / Co-organizer *(new)*

**Snapshot.** A trusted, active member given part of the leader's responsibilities: inviting people, welcoming them, and possibly removing them. This persona appears in the PRD but not in the raw note. The protocol supports it through `requester_predicate`, which controls who may issue; field `update_policy`; and `revocation_permissions`.

**Design implications**
- Stewards see a scoped version of the leader tools: invite, see and message the people they invited (T6), and possibly revoke within their scope.
- The UI must make clear what a steward *can't* do, so they don't hit unexplained press rejections.

---

### P6 — Resource Owner / Integrator *(new)*

**Snapshot.** The person who connects a card to a resource. Examples: Marco's members-only Squarespace page, a card-gated Matrix room, a Minecraft server, a partner organization's website. In small communities this is often P1 or P3 themselves.

**What the protocol requires**
- The requesting site needs its own *requester card* (§8).
- It must sign auth requests, verify responses (§7), and handle the confirmation-code redirect.

**Design implications**
- Either no-code integration surfaces (an embeddable "Sign in with your card" button, a Squarespace-friendly snippet, a "create a gated room" wizard), or the integrator persona stays developer-only.
- This is a scope decision. See tension T5.

---

## 2. User stories

### A. Receiving and accepting a card

**A1 [R]** As a club member who got an invite link in WhatsApp, I want to see on one screen who is offering the card, what it is, and what it unlocks, so that I can decide in seconds whether it's worth my time.
- Merges original stories #12 and #14.
- The review screen must show (§4, open-offer receipt):
  - the issuer's identity and chain summary;
  - the proposed field values;
  - the remaining slots, if `max_acceptances` is set;
  - the expiry, if `expires_at` is set;
  - the redirect destination.
- Translate the chain summary into human terms, for example: "Offered by Marco · Organizer, Oakland Salsa Club · verified".

**A2 [R]** As a first-time recipient, I want to know whether this card is safe and legitimate, so that I don't fall for a scam.
- Verification runs before the offer is shown. An offer that fails verification is rejected and never displayed (§4), so design a clear rejection screen ("We couldn't verify who sent this").
- Answer the questions she will have:
  - Will they get my phone number? No. Messages reach the card, not a phone number.
  - Is this crypto? The answer depends on whether tokens ever show up in the UI (see `specs/Send Tokens.md`). Decide this before writing the copy.

**A3 [R]** As a first-time recipient, I want setting up my wallet and accepting my first card to feel like one step, so that getting a card isn't a separate project.
- Covered by `open_offer_acceptance_new_wallet.md`.
- The keypair and passkey are created in the browser, and the key is stored before countersigning.

**A4 [N]** As someone who already holds cards, I want to accept a new card without repeating setup, so that adding a second community takes seconds.
- Covered by `open_offer_acceptance_existing_wallet.md`.

**A5 [O]** As a card holder, I want to review a card offered to me as a message to one of my existing cards (a targeted offer), and decide whether to accept it.
- §4, existing-recipient flow (`card_offer` message type).
- The offer arrives in the inbox, so an inbox item needs to be able to become an offer review.

**A6 [N]** As a recipient, I want to decline an offer, so that I'm not left with a pending item.
- `card_offer_declined` exists in the messaging protocol as an audit record of the refusal.
- §4 still lists "should a decline notify?" as an open design question. Tell the user whether the offerer will find out.

**A7 [N]** As a recipient whose link has expired or filled up, I want a clear reason and a next step, so that I'm not stuck staring at a spinner.
- E-12 (expired) and E-13 (at capacity) are the relevant errors.
- Next step: "Ask Marco for a new link." A waitlist is P2 in the spec.

**A8 [N]** As a recipient who just claimed a card, I want to see where I'm being sent next before I'm redirected, so that I'm not phished.
- The spec requires showing `redirect_url` before navigating, and warning about known phishing domains.

---

### B. The wallet: holding and browsing

**B1 [O]** As a member, I want to browse all the cards I hold and the messages I've received, so that I have one home for my communities.
- Open question: is the primary view organized by card or by inbox? See "Questions to settle in interviews" at the end.

**B2 [R]** As a member, I want to see what each card gives me access to, right after I receive it and at any time later, so that the card feels useful.
- Spec support so far:
  - card-gated Matrix rooms, through the room index (`room_discovery.md`);
  - the offer's `redirect_url`;
  - the policy's field descriptions.
- There is no general registry of "websites that accept this card". See tension T5.

**B3 [N]** As a holder, I want to see my card's status and history (endorsements, notes, changes, expiry), so that I know where I stand.
- Source: the append-only log with 1xx–7xx entries (§5).

**B4 [N]** As a holder, I want to be told when someone updates my card, along with any message they included, so that changes don't surprise me.
- `card_update_notification` carries the `updater_message`.
- The default is to notify, but the issuer or the policy can suppress notification. Design the in-app history so changes are still discoverable even when no notification was sent.

**B5 [N]** As a holder who disagrees with an annotation or revocation on my card, I want to post my side, so that verifiers see both.
- §5 P2: an update dispute is a holder counter-statement (4xx).

**B6 [N]** As a member leaving the club, I want to give up my card voluntarily, so that I leave cleanly and in good standing.
- Code 801 is voluntary surrender, a quiet revocation that holders are allowed to post by default.

---

### C. Using a card

**C1 [O]** As a member, I want to log in to a website that asks for a card login, so that I don't need another account.
- §8 flow:
  1. The site opens the wallet (CHAPI popup, or a QR code / deep link as the P1 fallback).
  2. The wallet shows the purpose, the requester's verified chain, and exactly what will be signed.
  3. The member approves or declines.
  4. The site redirects with a confirmation code.

**C2 [O]** As a member, I want to open a resource my card unlocks (a members' room or a members-only page) in one tap from the card.
- For Matrix: join attestation and the room predicate check (`matrix_room_membership.md`, `matrix_join_attestation_and_revocation.md`).

**C3 [N]** As a member, I want to know who is asking before I share my card, so that I don't present it to an impostor site.
- The requester's chain is verified, and a request that fails verification is never displayed (§8 acceptance criteria). The requester's identity should get more visual weight than its domain.

**C4 [N]** As a member who qualifies through more than one card, I want to choose which card to present, so that I control what I reveal.
- §8 P1 wallet chooser.
- The "Card Auth" raw note also suggests a sticky "always use this card here" preference.

**C5 [N]** As a member who doesn't hold a qualifying card, I want a clear explanation and, if possible, a way to get one.
- §8 open design question: hide such requests, or show them with an explanation.

**C6 [N]** As a member, I want to sign a statement with my card, alone or alongside others, so that it carries the weight of my membership.
- §6 covers signing and parallel co-signing, for example a community letter that many members sign.

---

### D. Messaging

**D1 [R]** As a club leader, I want to send an announcement to all members' cards, so that I can reach them outside WhatsApp's limits.
- The `announcement` message type exists.
- Delivery at scale is an open question: per-recipient encryption versus a group key (MSG-OQ-7).
- The member list comes from the T6 decision: the leader can address every card they granted or that was issued under their policies (see E3a).

**D2 [O]** As a member, I want to receive messages and see at a glance that they really come from my club, so that I can trust them.
- §7's structured result feeds a trust indicator.
- Open design question from the spec: how to show "verified to a root I trust" versus "verified to an unknown root".

**D3 [R]** As a member, I want to message another member through their card, so that we can talk without swapping phone numbers.
- Addressing a card requires its public key; the address is a hash of it.
- The spec gives no way for a member to find another member's card. Two partial routes:
  - `introduction` messages, where a leader or steward introduces two members, optionally vouching;
  - a card-gated room.
- See tension T7.

**D4 [N]** As a sender, I want to reply to, react to, edit, retract, or forward a message, so that messaging feels normal.
- §6 and messaging protocol types 2–4.
- Edits and retractions are new signed messages, so design visible edit history.
- Forwarding uses a ForwardPackage, which should show as "forwarded".

**D5 [N]** As a member, I want to report a harmful message, so that the community can act.
- The `flag` type goes to the issuing press or a safety card.
- Flags are not anonymous; the UI must say so before sending.
- An active flag blocks deletion of the flagged message.

**D6 [N]** As a member, I want to control read receipts and remove messages from my device, so that I control my own metadata.
- Read receipts are opt-in (`read_receipt`).
- `delete` has three scopes: local, sender, and all.

**D7 [N]** As a member reading a message from someone whose card was later revoked, I want to understand whether that message was trustworthy when it was sent.
- §7 historical semantics:
  - 8xx: messages sent before the effective date stay trusted.
  - 9xx: messages on or after the effective date are suspect.

---

### E. Issuing and managing members (Leader, Steward)

**E1 [O]** As a club leader, I want to create an invite link for my card type and share it in WhatsApp or Discord, so that members can claim cards without me being online.
- Settings to design for: `max_acceptances`, `expires_at`, `display_message`, `redirect_url`, and pre-filled field values.
- An invite link with no limits at all requires explicit acknowledgment from the issuer.
- The policy must have `allow_open_offers: true`.
- QR codes are P1.

**E2 [N]** As a mutual aid leader, I want to offer a card to one specific person instead of posting a link, so that only the person I vetted can claim it.
- Covered by the targeted flow in §2 and §4.

**E3 [O]** As a leader, I want to review the cards I've granted (who, when, which link, status), so that I know my membership.
- Per the T6 decision, issuers see the cards they granted, and policy holders see every card issued under their policies.
- Filters to design for: by card type, by issuer (which steward), by invite link, and by status (active, expired, or revoked; revoked cards are greyed out).

**E3a [N]** As a leader, I want to message any card I've granted, or that was issued under a policy I created, either one person at a time or all of them at once, so that the people I've brought in can always hear from me.
- Collective sends use the `announcement` type. Individual sends use `text`.
- Collective sends need targeting: all cards, one card type, one invite link's claimants, or one steward's invitees.
- A collective send goes to a fixed list of recipients at the moment of sending. Show the count ("Sending to 47 cards"). Whether greyed-out (revoked) cards are included is a design call still to make.

**E4 [N]** As a leader, I want to watch an invite link (claims so far, slots left) and shut it down early if it leaks, so that a forwarded link doesn't flood the club.
- The issuer gets a courtesy notification per claim.
- The spec has no way to cancel an open offer before it expires. See tension T8.

**E5 [O→R]** As a leader, I want to remove a member I'm allowed to remove, and choose how serious the removal is, so that the consequences fit what happened.
- Choices the leader makes:
  - quiet (8xx, "departed in good standing") or loud (9xx, "may pose risk to other communities");
  - a reason code;
  - an effective date, which can be backdated and so invalidates signatures made after that date;
  - whether to notify the member, plus an optional message.
- Permissions come from `revocation_permissions`.
- This flow needs the strongest guardrails in the product. See tension T10.

**E6 [N]** As a leader who revoked someone by mistake, I want to restore them, so that an error doesn't follow them forever.
- Revocations can't be removed. The fix is a successor card with `supersedes` and a `supersession_note`; the old revocation stays visible.

**E7 [N]** As a leader, I want to endorse, annotate, or flag a concern on a member's card, so that the record reflects reality without escalating to removal.
- 2xx endorsement, 4xx informational note, 6xx concern, 7xx privilege reduction.
- Ties to the "Third party attestations" raw note.

**E8 [N]** As a leader, I want to update a member's details, such as making them a steward or changing their level, so that cards stay accurate.
- Field updates with codes 1xx–5xx, governed by each field's `update_policy`.
- A concurrent edit can fail on a stale log head; design the retry.

**E9 [N]** As a leader, I want to let stewards invite (and maybe remove) people, so that the work is shared.
- `requester_predicate`, `revocation_permissions`, and M-of-N approval (§5 P1).

**E10 [N]** As a leader, I want to see the invite chain for any member, so that I know who vouched for whom.
- Chain walk. Also a PRD P0 story.

---

### F. Defining card types (policies) and resources

**F1 [R]** As a club leader, I want to define a new card type by answering plain questions, so that the rules exist without my writing JSON. The questions, and the spec fields they map to:

| Question | Spec field |
|---|---|
| What's it called and what does it mean? | `notes`, field descriptions |
| What information does it carry? | `field_definitions` |
| Who can give it out? | `requester_predicate` |
| Who can receive it? | `recipient_predicate` |
| Who can remove it, and how? | `revocation_permissions` |
| Can it be shared by link? | `allow_open_offers` |
| When does it expire? | `valid_until` |
| Who can change each detail later? | each field's `update_policy` |

- A visual policy builder is an explicit §1 non-goal (P2). See tension T2.

**F2 [N]** As a leader, I want to start from a template such as "club membership", "volunteer", or "event attendee", so that I don't design rules from scratch.
- §1 P1 template library, plus a human-readable policy summary.

**F3 [N]** As a leader, I want to change a card type later (add a field, change who can issue, add an auditor) and understand what that does to cards already issued.
- Cards are checked against the policy snapshot taken at issuance, except that permission to update or revoke follows the *live* policy.
- How to handle a newly added field is an open engineering question in §1 and §5.

**F4 [N]** As a mutual aid leader, I want chapters to create their own card types within limits I set, so that the network stays coherent.
- The `policy_creation` constraints and their chain walk (§1).

**F5 [N]** As a mutual aid leader acting as auditor, I want to receive and review a record of every card issued under my policies, so that I can catch misuse.
- `PressIssuanceRecord` delivery and auditor review (`log_auditing.md`).
- Key separation: the auditor key must not be the authorizer key.

**F6 [N]** As a leader, I want to create a members-only room (and other gated resources) that accepts one or more card types, so that the card unlocks something real.
- `POST /matrix/rooms`. A room's predicate can list several policies, optionally with field matches.

**F7 [N]** As a leader, I want to retire a card type, so that no new cards are issued under it.
- `valid_until`, or revoking the policy card. Cascading revocation is P2.

---

### G. Security, recovery, and devices

**G1 [N]** As a new holder, I want my keys secured without seeing or managing them, so that security doesn't cost me effort.
- Passkey plus service secret (§3). Synced passkey is the default tier.

**G2 [N]** As a security-conscious user, I want to add a YubiKey backup and choose where recovery alerts go, so that only I can recover my wallet.
- §3 and `wallet_backup_and_recovery.md`. Alert channels: email, SMS, webhook, and secondary contacts.

**G3 [N]** As a holder who lost my phone, I want to recover my cards and understand why there's a 72-hour wait, so that I don't think it's broken.
- Design a recovery-in-progress state with a countdown and an explanation.

**G4 [N]** As a holder, I want to be alerted and able to cancel if someone else starts recovering my wallet, so that a stolen backup can't take over my identity.
- The 72-hour cancellation window.

**G5 [N]** As a holder, I want to approve a new device or app before it can act for my card, and see what it's allowed to do.
- `subcards.md` step 3: the user authorizes the sub-card, and its capabilities are fixed at issuance.
- Other devices get a `subcard_sibling_added` notice.

**G6 [N]** As a holder, I want to remove a lost device, so that it can't sign as me.
- Sub-card deregistration and code 811.

**G7 [N]** As a holder who thinks my card is compromised, I want a single "something's wrong" action that guides me through the right response.
- The options it chooses between: emergency rotation (101), self-revocation (810), or "full wallet compromise" (910).

**G8 [N]** As a leader, I want to help a member who lost access get their card back; as that member, I want to be able to stop it if I didn't ask.
- Issuer-initiated recovery rotation (102) has a 72-hour pending window; the holder can cancel it (103). Covered in `key_rotation.md` §2.6.

**G9 [N]** As a holder, I want to move my wallet to a different service provider, so that I'm not locked in.
- `card_migration.md`. Requires the master key.

**G10 [N]** As a holder, I want to choose which organizations I trust as roots, so that "verified" means something to me.
- The spec calls trusted-root configuration UX "a dependency" that design work should start on early (Timeline section; §7 open questions).

---

## 3. Spec coverage matrix

| Spec use case | Spec reference | In original doc? | Stories here |
|---|---|---|---|
| Create a policy | §1, `policy_creation.md` | Partly (one story, plain-language framing) | F1–F3 |
| Policy creation constraints for sub-orgs | §1 `policy_creation` | No | F4 |
| Approve or register presses | §1, §2 | No | Hidden behind the hosted service (T1) |
| Auditors and issuance records | §2, `log_auditing.md` | No | F5 |
| Targeted issuance | §2, §4, `card_offering_and_acceptance.md` | Yes (via message, #13) | A5, E2 |
| Open offer creation | §2, `open_offer_creation.md` | Yes (#1) | E1, E4 |
| Open offer acceptance (new wallet) | §4, `open_offer_acceptance_new_wallet.md` | Yes (#2, #12, #14) | A1–A3, A7, A8 |
| Open offer acceptance (existing wallet) | `open_offer_acceptance_existing_wallet.md` | Implicit | A4 |
| Decline an offer | §4 open question, `card_offer_declined` | No | A6 |
| Keychain setup | §3 | No | G1 |
| YubiKey backup and recovery | §3, `wallet_backup_and_recovery.md` | No | G2–G4 |
| Sub-cards / device and app authorization | §3, `subcards.md` | No | G5, G6 |
| Key rotation (planned, emergency, issuer-initiated) | `key_rotation.md` | No | G7, G8 |
| Wallet migration | `card_migration.md` | No | G9 |
| Field updates (1xx–5xx) | §5 | No | E8 |
| Annotations (2xx, 4xx, 6xx) and privilege reduction (7xx) | §5, update codes | No | E7 |
| Revocation (8xx, 9xx) | §5 | Yes (#11), without the quiet/loud nuance | E5 |
| Self-revocation (801, 810, 811) | §5 | No | B6, G6, G7 |
| Un-revocation via successor card | Background: codes | No | E6 |
| Holder notified of updates | §5 | No | B4 |
| Update dispute | §5 P2 | No | B5 |
| Signing messages, co-signing | §6 | Partly (messaging only) | C6, D4 |
| Edit, retract, forward, reply, react | §6, messaging protocol | No | D4 |
| Verifying messages / trust indicator | §7 | Implicit | D2, D7 |
| Trusted-root configuration | §7 open question, Timeline | No | G10 |
| Card login (auth) | §8 | Yes (#9) | C1, C3–C5 |
| Wallet chooser | §8 P1 | No | C4 |
| Announcements | `messaging_protocol.md` #18 | Yes (#4), as messaging | D1, E3a |
| Issuer and policy-holder card lists | `protocol-objects.md §11`, §2 Issuance Records | Partly (#10) | E3, E3a |
| Introductions | `messaging_protocol.md` #17 | No | D3 |
| Flagging / reporting | `messaging_protocol.md` #21 | No | D5 |
| Read receipts, delete | `messaging_protocol.md` #19, #20 | No | D6 |
| Card-gated Matrix rooms (create, join) | `matrix_room.md`, membership specs | Partly (#8, "access a resource") | C2, F6 |
| Room discovery by card | `room_discovery.md` | Partly (#3) | B2 |
| Notification delivery (push, SSE, WS) | `notification_relay.md` | Implicit (#6) | D2, B4 |
| API / MCP card messaging | `messaging_protocol.md` #11–12 | No | Not covered here; agent and developer persona, later |
| Offer board / exchanges | `mutual_aid_mvp.md` (product PRD, not protocol) | No | Separate brief recommended |

---

## 4. Tensions and gaps to resolve before UX work

**T1 — Who plays authorizer, press, and root for a salsa club?** The protocol assumes an authorizer issues the policy card, a press validates and registers it, and, for new trust anchors, a governance bootstrap. Marco can't do any of this. Decide whether there is a hosted "community starter" service that acts as authorizer and press, and how that relationship appears in the UI, especially as the "verified by …" line on every card.

**T2 — A policy builder is a spec non-goal (P2), but it's core to the leader stories.** The frontend needs at least a guided, template-based builder that outputs policy JSON. Either reclassify it as P1, or scope v1 to templates with a few parameters.

**T3 — The wallet surface.** The PRD favors the browser. Sub-cards want secure-enclave storage. Card login uses a CHAPI popup with QR / deep link as fallback. Decide what v1 is: web app, PWA, or native, and whether the answer differs for leaders and members.

**T4 — Language.** Spec terms (card, policy, press, sub-card, offer, revocation) need a user-facing vocabulary, which is the subject of Brief 03. "Card" itself works well for users.

**T5 — Resource discovery.** Only Matrix rooms and the post-claim redirect are discoverable from a card. Anything else, such as a Squarespace page, a server, or a partner site, has no registry. The "what does my card unlock" story (B2), the most important hook for members, depends on this.

**T6 — The issuer's view of their members. *Decided 2026-10-23; spec updated.*** Anyone who grants a card, and the holder of the policy it was granted under, builds up a list of the cards created. Both can message those cards one at a time or all together.
- **Mechanism.** The press now sends the `PressIssuanceRecord`, which carries the new card's public key, to three groups: the policy's auditors, the issuing card, and the policy card's holder (`protocol-objects.md §11`, `card_protocol_spec.md §2 Issuance Records`).
- **Who sees what.** The issuer's list covers only the cards it granted. The policy holder's list covers every card issued under the policy, including cards stewards issued. For open offers, the record also says which invite link was used.
- **Visibility.** A list is visible only to the parties that receive these issuance records, the same way the auditor record works. It is never posted to IPFS or on-chain.
- **Revoked cards** stay in the list and are shown greyed out.
- **Still open:** does a list carry over when a policy card changes hands, for example through key rotation or a successor card?

**T7 — Member-to-member messaging.** You need a card's public key to address it. There is no member directory, which is defensible for privacy. Choose a discovery model: introductions, QR exchange in person, opt-in directories, or rooms only.

**T8 — Killing a leaked invite link.** There is no mechanism to cancel an open offer before it expires; only `max_acceptances` and `expires_at` exist. Leaders will expect a "disable link" button.

**T9 — Open links versus security posture.** Open offers make P1 and P2 easy but undercut P3's threat model. Consider per-policy defaults (mutual aid: targeted only) and the P2 offer-provenance metadata.

**T10 — Revocation ethics.** A 9xx revocation follows a person across communities, and a backdated effective date invalidates their past signatures. A non-technical leader choosing "loud" in a heated moment is a real harm vector. Consider a default of quiet, a cooling-off period or second approver for 9xx, and plain explanations of what each choice does.

**T11 — Total loss.** If someone loses both their passkey and their YubiKey, v1 has no recovery (§3 open question). The UX must at least say so honestly during setup.

**T12 — Linkability across services.** The same card used to log in to many services is correlatable. The Card Auth notes suggest getting separate cards per service. Decide whether the UI ever exposes this.

**Spec open questions that are design calls:**
- whether a decline notifies the offerer (§4);
- whether to hide or show auth requests the user can't satisfy (§8);
- how the trust indicator shows a known versus an unknown root (§7);
- read-receipt privacy for sensitive notices (MSG-OQ-16).

---

## 5. Questions to settle in interviews

**Club Leader**
- Which resources would you actually put behind a card first?
- How do you remove someone today?
- Would you ever want a co-organizer to invite or remove people?
- Would you pay, or would the club pay, for hosting?

**Club Member**
- What would make you tap a link from your club leader?
- What would make you close it?
- Have you used "Sign in with Apple/Google"?
- Do you know what a passkey is?

**Mutual Aid Leader**
- What is the threat model in concrete terms: who are you protecting against?
- Who should be able to see the member list?
- How do you vet new people today?
- What should happen, socially, when someone is removed?
- Would you self-host anything?

**Mutual Aid Participant**
- What do you use today to coordinate?
- What made you trust or distrust it?
- What happens if you lose your phone?
- Is a shared device common?

**Everyone**
- Do you think of your cards as "in a wallet", "in an inbox", or "under each community"? This answers the B1 question.
