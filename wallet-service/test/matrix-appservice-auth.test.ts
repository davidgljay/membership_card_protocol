import { describe, it, expect } from 'vitest';
import { verifyHomeserverToken } from '../src/matrix/appservice-auth.js';

// Covers server/routes/matrix/transactions/[txnId].put.ts's (Step 15a) auth
// check — Synapse authenticates itself to the AS with a bearer token equal
// to this AS's own hs_token, in either the Authorization header or the
// access_token query param; the route reduces both to a single
// `providedToken` before calling this.
describe('verifyHomeserverToken (Step 15a AS transaction-push auth)', () => {
  const HS_TOKEN = 'a'.repeat(64);

  it('accepts the correct hs_token', () => {
    expect(verifyHomeserverToken(HS_TOKEN, HS_TOKEN)).toBe(true);
  });

  it('rejects a missing token', () => {
    expect(verifyHomeserverToken(undefined, HS_TOKEN)).toBe(false);
  });

  it('rejects an empty-string token', () => {
    expect(verifyHomeserverToken('', HS_TOKEN)).toBe(false);
  });

  it('rejects a wrong token of the same length', () => {
    const wrong = 'b'.repeat(64);
    expect(verifyHomeserverToken(wrong, HS_TOKEN)).toBe(false);
  });

  it('rejects a wrong token of a different length', () => {
    expect(verifyHomeserverToken('short', HS_TOKEN)).toBe(false);
  });

  it('rejects a token that is merely a prefix of the correct one', () => {
    expect(verifyHomeserverToken(HS_TOKEN.slice(0, 10), HS_TOKEN)).toBe(false);
  });
});
