/**
 * Minimal Kubo HTTP API client for pinning fixture content (e.g. the test
 * policy document) to the stack's `ipfs` service and getting back a real
 * CID — mirrors `press/src/ipfs/kubo.ts`'s `pinToIPFS` exactly (same
 * endpoint, same `cid-version=1&pin=true` query), since fixtures need to
 * hand press a policy CID that press's own Kubo client can actually
 * resolve.
 */

export async function pinJsonToKubo(apiUrl: string, value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const form = new FormData();
  form.append('file', new Blob([bytes as unknown as BlobPart]));

  const res = await fetch(`${apiUrl.replace(/\/$/, '')}/api/v0/add?cid-version=1&pin=true`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    throw new Error(`pinJsonToKubo: Kubo add failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { Hash?: string };
  if (!body.Hash) {
    throw new Error('pinJsonToKubo: Kubo add response did not include a Hash (CID)');
  }
  return body.Hash;
}
