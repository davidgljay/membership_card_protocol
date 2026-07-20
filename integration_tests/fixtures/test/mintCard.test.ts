/**
 * Live-stack smoke test — requires `docker compose up --wait` already
 * running in `integration_tests/` (press on :3001, ipfs on :5001/:8080).
 * Not run as part of any component's own `npm test`; this is what proves
 * fixtures' "Done when" criterion (2.1): a fixture helper can produce a
 * signed card accepted by the live press.
 */

import { describe, it, expect } from 'vitest';
import { buildPermissiveTestPolicy } from '../src/policy.js';
import { pinJsonToKubo } from '../src/ipfs.js';
import { mintCard } from '../src/mintCard.js';

const PRESS_BASE_URL = process.env.FIXTURE_PRESS_URL ?? 'http://localhost:3001';
const KUBO_API_URL = process.env.FIXTURE_KUBO_API_URL ?? 'http://localhost:5001';

describe('mintCard (live stack)', () => {
  it('mints a card accepted by the live press', async () => {
    const pressInfo = (await (await fetch(`${PRESS_BASE_URL}/api/press`)).json()) as { press_card_cid: string };
    const policy = buildPermissiveTestPolicy(pressInfo.press_card_cid);
    const policyCid = await pinJsonToKubo(KUBO_API_URL, policy);

    const result = await mintCard({
      pressBaseUrl: PRESS_BASE_URL,
      policyId: policyCid,
      label: `smoke-${Date.now()}`,
      fieldValues: { display_name: 'Fixture Smoke Test' },
    });

    expect(result.cardCid).toBeTruthy();
    expect(result.scip).toBeTruthy();
  }, 30_000);
});
