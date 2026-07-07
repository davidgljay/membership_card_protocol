import type { ObliviousProtocolTransport } from '@membership-card-protocol/app-sdk';

/**
 * Shared JSON request/response helper for every wallet-service call in this
 * module — extracted from `setupWallet.ts` (Step 2.1) so `recovery.ts`
 * (Step 2.4) can reuse the same throw-on-non-2xx convention instead of
 * duplicating it.
 */
export async function requestJson<T>(
  transport: ObliviousProtocolTransport,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<T> {
  const response = await transport.request(
    { kind: 'wallet_service' },
    {
      method,
      path,
      ...(body !== undefined
        ? { body: new TextEncoder().encode(JSON.stringify(body)), headers: { 'content-type': 'application/json', ...headers } }
        : headers
          ? { headers }
          : {}),
    }
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${path}: ${method} returned status ${response.status}`);
  }
  return JSON.parse(new TextDecoder().decode(response.body)) as T;
}
