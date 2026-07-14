/**
 * Production wiring seam for `room-discovery.ts`'s `CardChainVerifier`
 * (matrix-implementation-plan.md Phase 4 Step 16c;
 * specs/process_specs/room_discovery.md §3).
 *
 * **Known gap, documented rather than papered over:** a real
 * `CardChainVerifier` requires a full `@membership-card-protocol/verifier`
 * `RpcProvider` — `getCardEntry`, `isPolicyAuthorizer`, `getPressAuthorization`,
 * `getSubCardEntry`, `getLogEntries`, `getEasAnnotations` (see
 * `membership_card_verifier/packages/verifier/dist/types.d.ts`). Nothing in
 * this codebase implements that interface today:
 *   - `wallet-service/src/chain/subcard-registry.ts` only reads
 *     `GetSubCardEntry` (a single narrow contract call for UUID-registration
 *     signature verification) — nowhere near the full surface.
 *   - `press/src/chain/registry.ts` (the only other on-chain client in this
 *     repo) exposes only the press-*writable* subset plus a couple of reads
 *     (`GetCardEntry`, `GetPressAuthorization`, `GetSubCardEntry`) — no
 *     `IsPolicyAuthorizer`, no log/EAS reads.
 *   - `getLogEntries` isn't a single contract call at all: per
 *     `specs/card_protocol_spec.md` / `specs/ARCHITECTURE.md`, a card's log
 *     is a singly-linked chain of IPFS entries reachable only by walking
 *     `prev_log_root` pointers from the head CID (`GetCardEntry.log_head_cid`)
 *     — an `RpcProvider` implementation has to combine one contract read with
 *     an IPFS walk of unbounded depth to satisfy it.
 *   - `getEasAnnotations` requires wiring the actual EAS (Ethereum Attestation
 *     Service) contract on Arbitrum One — not referenced anywhere in this
 *     codebase yet.
 * `membership_card_verifier/packages/verifier-rpc-provider`'s
 * `EthersRpcProvider` doesn't remove this gap either: it still needs a
 * caller-supplied `RegistryContract` implementing that same full surface,
 * and it's built on ethers.js, not this service's viem stack.
 *
 * Building that out is a real, standalone subsystem — not something this
 * step (which is about the discovery *endpoint*, reusing Step 16b's
 * already-built predicate-evaluation logic) should invent inline. Exactly
 * like client-sdk's `discoverRooms` (`client-sdk/packages/client-sdk/src/
 * matrix/discovery.ts`) takes a pre-built `CardChainVerifier` as a parameter
 * rather than assembling one from a raw RPC URL, `discoverEligibleRooms`
 * (`./room-discovery.ts`) takes the same minimal interface — so the actual
 * discovery algorithm is fully implemented and tested today, independent of
 * when this factory gets a real implementation.
 *
 * `createCardChainVerifier` exists so the route has exactly one place to
 * wire a real verifier into once the RPC/IPFS/EAS provider work above lands
 * (tracked as a follow-up, not part of this step). Until then it throws
 * clearly rather than silently returning an empty/always-denying chain.
 */

import type { WalletServiceConfig } from '../config.js';
import type { CardChainVerifier } from './room-discovery.js';

export class CardChainVerifierNotConfiguredError extends Error {
  constructor() {
    super(
      'No production CardChainVerifier is wired up yet: wallet-service has no ' +
        'RpcProvider implementation covering the full verifier surface ' +
        '(getLogEntries / isPolicyAuthorizer / getEasAnnotations) — see ' +
        'src/matrix/card-chain-verifier.ts for the full explanation. ' +
        'POST /matrix/discover-rooms cannot serve real requests until this is built.'
    );
  }
}

/**
 * `_config` is accepted (not `void`) so the eventual real implementation's
 * signature doesn't need to change at every call site — only this
 * function's body does, once an `RpcProvider`/`IpfsProvider` pair exists.
 */
export function createCardChainVerifier(_config: WalletServiceConfig): CardChainVerifier {
  return {
    async verifyEnvelope(): Promise<import('@membership-card-protocol/verifier').EnvelopeVerificationResult> {
      throw new CardChainVerifierNotConfiguredError();
    },
  };
}
