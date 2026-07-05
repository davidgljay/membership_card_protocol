import { canonicalize } from '../crypto/canonicalize.js';
import { bytesToBase64Url } from '../util/base64url.js';
import { randomBytes } from '@noble/hashes/utils.js';
import type { ObliviousProtocolTransport } from '../providers/ObliviousProtocolTransport.js';

/**
 * UUID registration with session separation and staggering (Step 5.3):
 * `notification_relay.md §Process 1` "Wallet registration" (step 6) and
 * `§Registration Privacy`.
 *
 * **Structural session separation.** `§Registration Privacy` states this
 * plainly: "Sending more than one card's UUIDs to a wallet service in one
 * message or session is not permitted... regardless of transport" — a
 * single signed envelope naming two `card_hash` values would tell a
 * shared wallet service those cards are co-owned by content alone, which
 * an anonymizing transport (Tor, or this SDK's oblivious-relay path) does
 * nothing to prevent. This module enforces the constraint two ways:
 *
 * 1. **Type-level**: {@link registerCardUuids}'s options accept exactly
 *    one `cardHash`/`subCardHash` pair and one `uuids` array — there is no
 *    parameter shape through which a caller could name a second card in
 *    the same call, unlike (say) an array-of-cards parameter that would
 *    make batching representable even if discouraged by convention.
 * 2. **Session-level**: the caller supplies a
 *    {@link ObliviousProtocolTransportFactory} — a function that
 *    constructs a *fresh* `ObliviousProtocolTransport` instance — rather
 *    than a single shared transport. {@link registerMultipleCardsUuids}
 *    (the only entry point that handles more than one card at all, and
 *    only ever as an orchestration convenience over N independent calls,
 *    never as a batched wire request) calls the factory once per card,
 *    so each card's registration runs against its own transport instance
 *    with its own OHTTP key-config cache and, when the injected factory
 *    constructs a transport bound to a fresh underlying connection/agent
 *    (as the default web/RN factories do — see those packages), its own
 *    underlying session. A test-harness factory can trivially observe
 *    this: each call's transport is a distinct object, so request-level
 *    call inspection (e.g. counting distinct `fetch` stub instances, or
 *    a session-id header the factory stamps in) can confirm no state
 *    leaked between cards' registrations.
 *
 * **Staggering.** `registerMultipleCardsUuids` inserts a randomized delay
 * (`§Registration Privacy` — "randomized delays of minutes to hours")
 * between successive cards' registrations. The unit-testable minimum is
 * configurable (`minStaggerDelayMs`/`maxStaggerDelayMs`) rather than
 * hardcoded to the spec's real-world minutes-to-hours range, so a test
 * can set a small-but-nonzero window and assert the actual elapsed time
 * between two registrations is at least that configured minimum, without
 * a multi-hour-long test run.
 */

export interface RegisterCardUuidsOptions {
  transport: ObliviousProtocolTransport;
  /** On-chain registry address of the card. */
  cardHash: string;
  /** `keccak256(subcard_pubkey)` — must match the subcard this signature proves control of. */
  subCardHash: string;
  /** UUIDs allocated to this card, from the relay's `POST /register` pool (device-local bookkeeping, `§Process 1` step 5 — out of this module's scope). */
  uuids: string[];
  /** Signs the registration payload with the subcard's own private key, proving control per `§Process 1` step 6's signed-envelope requirement. */
  sign: (message: Uint8Array) => Uint8Array | Promise<Uint8Array>;
  /** base64url ML-DSA-44 public key of the subcard — included so the wallet service can resolve/verify without a second round trip; the wallet still independently re-derives `keccak256(subcard_pubkey) == subcard_hash` itself (`§Process 1` step 7). */
  subCardPublicKey: string;
}

export interface RegisterCardUuidsResult {
  registered: boolean;
}

interface UuidRegistrationPayload {
  card_hash: string;
  subcard_hash: string;
  uuids: string[];
  timestamp: string;
  nonce: string;
}

/**
 * One card's UUID registration — exactly the wire shape
 * `notification_relay.md §Process 1` step 6 specifies: a signed envelope
 * proving control of the subcard the UUIDs are being registered for, not
 * a bare list. Structurally cannot name a second card (see this module's
 * doc comment).
 */
export async function registerCardUuids(options: RegisterCardUuidsOptions): Promise<RegisterCardUuidsResult> {
  const payload: UuidRegistrationPayload = {
    card_hash: options.cardHash,
    subcard_hash: options.subCardHash,
    uuids: options.uuids,
    timestamp: new Date().toISOString(),
    nonce: bytesToBase64Url(randomBytes(32)),
  };
  const signature = await options.sign(canonicalize(payload));

  const response = await options.transport.request(
    { kind: 'wallet_service' },
    {
      method: 'POST',
      path: `/cards/${options.cardHash}/subcards/${options.subCardHash}/uuids`,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(
        JSON.stringify({
          payload: { ...payload, public_key: options.subCardPublicKey },
          signature: bytesToBase64Url(signature),
        })
      ),
    }
  );

  return { registered: response.status >= 200 && response.status < 300 };
}

/** Constructs a fresh `ObliviousProtocolTransport` for one card's registration session — see this module's doc comment for why this is a factory, not a shared instance. */
export type ObliviousProtocolTransportFactory = () => ObliviousProtocolTransport;

export interface CardUuidRegistrationRequest {
  cardHash: string;
  subCardHash: string;
  uuids: string[];
  sign: (message: Uint8Array) => Uint8Array | Promise<Uint8Array>;
  subCardPublicKey: string;
}

export interface RegisterMultipleCardsUuidsOptions {
  transportFactory: ObliviousProtocolTransportFactory;
  cards: CardUuidRegistrationRequest[];
  /** Minimum randomized stagger delay between cards' registration sessions, ms. Default 1000 (spec's real-world default is minutes-to-hours; this is the unit-testable floor a caller should raise for production). */
  minStaggerDelayMs?: number;
  /** Maximum randomized stagger delay, ms. Default `minStaggerDelayMs * 3`. */
  maxStaggerDelayMs?: number;
  /** Injectable for testing; defaults to a real random delay via `setTimeout`. */
  delay?: (ms: number) => Promise<void>;
}

export interface CardUuidRegistrationOutcome extends RegisterCardUuidsResult {
  cardHash: string;
}

const DEFAULT_MIN_STAGGER_DELAY_MS = 1000;

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Orchestrates independent, staggered, separately-sessioned registration
 * for multiple cards on one device (`§Process 1` step 6: "For each card
 * separately — in its own session, staggered in time from any other
 * card's registration"). This is purely a device-local convenience loop
 * — no wire request ever carries more than one card's data; each
 * iteration is a fully independent {@link registerCardUuids} call against
 * a freshly-constructed transport.
 */
export async function registerMultipleCardsUuids(
  options: RegisterMultipleCardsUuidsOptions
): Promise<CardUuidRegistrationOutcome[]> {
  const minDelay = options.minStaggerDelayMs ?? DEFAULT_MIN_STAGGER_DELAY_MS;
  const maxDelay = options.maxStaggerDelayMs ?? minDelay * 3;
  const delay = options.delay ?? defaultDelay;

  const outcomes: CardUuidRegistrationOutcome[] = [];
  for (let i = 0; i < options.cards.length; i++) {
    if (i > 0) {
      const stagger = minDelay + Math.random() * (maxDelay - minDelay);
      await delay(stagger);
    }
    const card = options.cards[i]!;
    const transport = options.transportFactory();
    const result = await registerCardUuids({
      transport,
      cardHash: card.cardHash,
      subCardHash: card.subCardHash,
      uuids: card.uuids,
      sign: card.sign,
      subCardPublicKey: card.subCardPublicKey,
    });
    outcomes.push({ cardHash: card.cardHash, ...result });
  }
  return outcomes;
}
