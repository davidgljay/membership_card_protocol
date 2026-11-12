/**
 * card_login.md §Router Registration — after a card is accepted, the wallet
 * registers with the login router on the way to wherever the user was going
 * (open_offer_acceptance_new_wallet.md step 22a, existing-wallet step 17a,
 * card_offering_and_acceptance.md step 15a). The host navigates to the
 * returned URL instead of `next`; the router stores the wallet (add-only)
 * and forwards to `next` with no visible page.
 */
import type { WalletRegistrationToken } from '@membership-card-protocol/verifier';
import { routerRegistrationUrl } from '../login/setup.js';

export interface LoginRouterRegistration {
  routerOrigin: string;
  /** The wallet deployment's signed registration token. */
  token: WalletRegistrationToken;
  /** Where the user goes after registering (the offer's redirect_url). */
  next?: string;
  /** Skip when this wallet already registered with the router in this browser. */
  alreadyRegistered?: boolean;
}

export function registrationField(reg: LoginRouterRegistration | undefined): { routerRegistrationUrl?: string } {
  if (!reg || reg.alreadyRegistered) return {};
  return {
    routerRegistrationUrl: routerRegistrationUrl({ routerOrigin: reg.routerOrigin, token: reg.token, ...(reg.next ? { next: reg.next } : {}) }),
  };
}
