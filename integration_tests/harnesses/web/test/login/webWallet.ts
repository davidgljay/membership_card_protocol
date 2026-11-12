/**
 * A minimal web wallet for the login harness (step 4.8): a handler page that
 * reads the router's fragment and asks its backend to handle the request, and
 * a backend that does the wallet-sdk work — validate (card_login.md steps
 * 10–16), match, sign with the device sub-card, and return the form_post
 * fields, which the page submits in the browser. No approval prompt: the test
 * approves on the user's behalf.
 */
import {
  parseLoginHandoff,
  fetchAndValidateLoginRequest,
  matchLoginCredentials,
  buildLoginResponse,
  formPostFields,
} from '@membership-card-protocol/wallet-sdk';
import type { CardVerifier, ChainContext } from '@membership-card-protocol/verifier';
import type { EnvelopeSigner } from '@membership-card-protocol/app-sdk';

export const HANDLER_PAGE = `<!doctype html><meta charset="utf-8"><title>Harness Wallet</title>
<p id="status">Checking login request…</p>
<script>
(async () => {
  const res = await fetch('/api/handle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: location.href }) });
  const out = await res.json();
  if (out.error) { document.getElementById('status').textContent = 'Rejected: ' + out.error; return; }
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = out.action;
  for (const [k, v] of Object.entries(out.fields)) {
    const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = v; form.append(i);
  }
  document.body.append(form);
  form.submit();
})();
</script>`;

export function createWalletBackend(config: {
  verifier: CardVerifier;
  chain: ChainContext;
  heldCards: { pubkey: string }[];
  signer: EnvelopeSigner;
  protocolVersion: string;
  /** In-process fetch to the site (the harness's site lives behind Playwright routes). */
  fetch: typeof globalThis.fetch;
}) {
  return async function handle(body: { url: string }): Promise<{ action: string; fields: Record<string, string> } | { error: string }> {
    const handoff = parseLoginHandoff({ url: body.url });
    if ('error' in handoff) return { error: handoff.error };
    const validated = await fetchAndValidateLoginRequest({ handoff, verifier: config.verifier, fetch: config.fetch });
    if (!validated.valid) return { error: `${validated.code}: ${validated.reason}` };
    const matches = await matchLoginCredentials({ request: validated.request, heldCards: config.heldCards, chain: config.chain });
    if (matches.length === 0) return { error: 'LOGIN_NO_MATCHING_CARD' };
    const { response } = await buildLoginResponse({ validated, presentedCard: matches[0]!.card, signer: config.signer, protocolVersion: config.protocolVersion });
    return formPostFields(validated.request, response);
  };
}
