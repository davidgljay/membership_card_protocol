/**
 * Card login checks the press enforces on writes (press.md §5.1 step 7,
 * §5.3 steps 4a and 5a): `preferred_services` shape (P-29) and code-520
 * `domain_binding` intents (P-28).
 */

import {
  checkDomainBinding,
  readCardFields,
  type RpcProvider,
  type IpfsProvider,
} from '@membership-card-protocol/verifier';
import type { PressContext } from '../context.js';
import { createRpcProvider, createIpfsProviderAdapter } from '../context.js';

const pressError = (code: string, message: string) => Object.assign(new Error(`${code}: ${message}`), { pressCode: code });

/**
 * protocol-objects.md §2: an array (possibly empty) of { origin, name, icon?,
 * description? } with https origins (no path, default port) that are unique.
 * Returns a reason string when invalid, null when valid.
 */
export function preferredServicesProblem(value: unknown): string | null {
  if (!Array.isArray(value)) return 'preferred_services must be an array';
  const seen = new Set<string>();
  for (const [i, entry] of value.entries()) {
    if (!entry || typeof entry !== 'object') return `entry ${i} is not an object`;
    const e = entry as Record<string, unknown>;
    for (const k of Object.keys(e)) {
      if (!['origin', 'name', 'icon', 'description'].includes(k)) return `entry ${i} has unknown field '${k}'`;
    }
    if (typeof e['name'] !== 'string' || !e['name'].trim()) return `entry ${i} needs a non-empty name`;
    if (e['icon'] !== undefined && typeof e['icon'] !== 'string') return `entry ${i} icon must be a CID string`;
    if (e['description'] !== undefined && typeof e['description'] !== 'string') return `entry ${i} description must be text`;
    if (typeof e['origin'] !== 'string') return `entry ${i} needs an origin`;
    let url: URL;
    try {
      url = new URL(e['origin']);
    } catch {
      return `entry ${i} origin is not a URL`;
    }
    if (url.protocol !== 'https:' || url.port !== '' || url.origin !== e['origin']) {
      return `entry ${i} origin must be an https origin with no path or port, e.g. https://example.org`;
    }
    if (seen.has(url.origin)) return `entry ${i} repeats origin ${url.origin}`;
    seen.add(url.origin);
  }
  return null;
}

export function assertPreferredServices(fieldUpdates: { field: string; value: unknown }[] | undefined): void {
  for (const u of fieldUpdates ?? []) {
    if (u.field !== 'preferred_services') continue;
    const problem = preferredServicesProblem(u.value);
    if (problem) throw pressError('P-29', problem);
  }
}

function adapters(ctx: PressContext): { rpc: RpcProvider; ipfs: IpfsProvider } {
  return { rpc: createRpcProvider(ctx.registry, ctx.kv), ipfs: createIpfsProviderAdapter(ctx.ipfs) };
}

/**
 * press.md §5.3 step 4a — everything about a code-520 intent except the
 * self-update / signer-binding checks the caller already made (P-23, P-13).
 */
export async function assertDomainBindingIntent(
  ctx: PressContext,
  fieldUpdates: { field: string; value: unknown }[] | undefined,
  targetCardAddress: string,
  targetPubkeyB64: string
): Promise<void> {
  const updates = fieldUpdates ?? [];
  if (updates.length !== 1 || updates[0]!.field !== 'domain_binding') {
    throw pressError('P-28', 'code 520 must set exactly one field, domain_binding');
  }
  const loginRoot = ctx.config.PRESS_LOGIN_SERVICE_CERTIFICATION_ROOT;
  if (!loginRoot) throw pressError('P-28', 'this press is not configured with a login service branch');

  const target = targetCardAddress.toLowerCase().replace(/^0x/, '');
  const card = await ctx.verifier.verifyCard(target, { pubkey: targetPubkeyB64 });
  if (!(card.chain_card_addresses ?? []).map((a) => a.toLowerCase().replace(/^0x/, '')).includes(loginRoot)) {
    throw pressError('P-28', 'target card is not under the login service branch');
  }

  const { rpc, ipfs } = adapters(ctx);
  const current = await readCardFields(targetPubkeyB64, { rpc, ipfs });
  if (current && current.fields['domain_binding'] !== undefined) {
    throw pressError('P-28', 'domain_binding is already set and cannot change');
  }

  const binding = updates[0]!.value as { domain?: unknown };
  const domain = typeof binding?.domain === 'string' ? binding.domain : '';
  const result = await checkDomainBinding({
    binding,
    loginServiceCardAddress: target,
    // Any https origin on the bound domain itself is covered; this checks the
    // signature, the admin card's currency, and suspension.
    origin: `https://${domain}`,
    rpc,
    isCardCurrentlyValid: async (address) => (await ctx.verifier.verifyCard(address)).is_currently_valid !== false,
  });
  if (!result.ok) throw pressError('P-28', `${result.code}: ${result.reason}`);
}
