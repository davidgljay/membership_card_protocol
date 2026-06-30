/**
 * Relay HTTP client (implementation-plan.md §Step 4.4, relay.md §7.2).
 * `POST /deliver/{uuid}` — UUID possession is the credential, no auth
 * header needed.
 */

export type DeliverResult = 'delivered' | 'uuid_invalid' | 'server_error';

export async function deliverToRelay(
  relayBaseUrl: string,
  uuid: string,
  blob: string,
  fetchImpl: typeof fetch = fetch
): Promise<DeliverResult> {
  try {
    const res = await fetchImpl(`${relayBaseUrl}/deliver/${uuid}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blob }),
    });
    if (res.ok) return 'delivered';
    if (res.status === 404 || res.status === 410) return 'uuid_invalid'; // relay.md §7.2: unknown or already-consumed UUID — advance to the next one
    return 'server_error'; // 5xx or unexpected status
  } catch {
    // Network-level failure (relay unreachable, DNS, timeout, etc.) — treat
    // the same as a server error so the caller advances to the next UUID
    // rather than letting the exception propagate and fail the whole
    // POST /messages request the delivery was triggered from.
    return 'server_error';
  }
}
