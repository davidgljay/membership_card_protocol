/**
 * IPFS pinning provider backed by Filebase (S3-compatible object storage).
 *
 * Filebase pins every uploaded object to IPFS and returns the CID in the
 * `x-amz-meta-cid` response header. Content is publicly accessible through
 * the Filebase IPFS gateway (default: https://ipfs.filebase.io/ipfs/<cid>)
 * and any other IPFS gateway.
 *
 * Talks to Filebase's S3-compatible API via `aws4fetch` (a minimal,
 * fetch-based AWS SigV4 signer) rather than `@aws-sdk/client-s3` — the full
 * SDK's Node-targeted `runtimeConfig.js` (NodeHttpHandler, `loadNodeConfig`
 * env/file lookups) doesn't work under Cloudflare Workers' `nodejs_compat`
 * polyfill; it threw a minified "X is not a function" from deep inside
 * `new S3Client()`'s construction, confirmed live via `wrangler tail`. The
 * SDK's package.json *does* have a browser-safe `runtimeConfig.browser.js`
 * variant, but only bundlers resolving with the `browser` condition get it
 * — Nitro's cloudflare-module preset doesn't set that condition.
 * `aws4fetch` sidesteps the whole question: no Node-specific code paths at
 * all, just fetch() with signed headers. This is also just an
 * implementation swap behind `IpfsPinningProvider` — nothing here is AWS-
 * specific in the public interface; Filebase is one pluggable CID-pinning
 * backend among others (kubo.ts, mock.ts), not "the AWS one".
 *
 * pinToIPFS  — upload bytes, capture CID from response header, validate by
 *              re-fetching from gateway and byte-comparing, return CID string.
 * fetchFromIPFS — fetch raw bytes for a CID via the configured gateway.
 *
 * CID validation: after every upload the press re-fetches the content from
 * the gateway and compares byte-for-byte against what it uploaded. A mismatch
 * is a hard P-10 error; the CID is never used in any signed object or
 * on-chain write if validation fails.
 */

import { AwsClient } from 'aws4fetch';
import type { PressConfig } from '../config.js';
import type { IpfsPinningProvider } from './provider.js';

export function createFilebaseProvider(config: PressConfig): IpfsPinningProvider {
  const aws = new AwsClient({
    accessKeyId: config.FILEBASE_KEY,
    secretAccessKey: config.FILEBASE_SECRET,
    region: config.FILEBASE_REGION,
    service: 's3',
  });
  // Path-style URLs (endpoint/bucket/key), matching the prior S3Client's
  // forcePathStyle: true — Filebase's endpoint isn't set up for the
  // virtual-hosted-style (bucket.endpoint/key) alternative.
  const endpoint = config.FILEBASE_ENDPOINT.replace(/\/$/, '');
  const objectUrl = (key: string) => `${endpoint}/${config.FILEBASE_BUCKET}/${encodeURIComponent(key)}`;

  return {
    async pinToIPFS(content: Uint8Array): Promise<string> {
      // Use a content-hash-derived key so identical content maps to the same
      // S3 object (idempotent uploads). The key is hex of the first 16 bytes
      // of SHA-256(content) — unambiguous within a single press deployment.
      const keyHash = await sha256Hex(content);
      const key = `press/${keyHash.slice(0, 32)}`;

      let cid: string;
      try {
        cid = await uploadAndCaptureCid(aws, objectUrl(key), content);
      } catch (err) {
        throw Object.assign(
          new Error(`Filebase upload failed: ${String(err)}`),
          { pressCode: 'P-24' }
        );
      }

      // Re-fetch from gateway and compare bytes (P-10 guard).
      let fetched: Uint8Array;
      try {
        fetched = await fetchByCid(config.FILEBASE_GATEWAY_URL, cid);
      } catch (err) {
        throw Object.assign(
          new Error(`CID validation fetch failed after upload: ${String(err)}`),
          { pressCode: 'P-10' }
        );
      }

      if (!bytesEqual(content, fetched)) {
        throw Object.assign(
          new Error(
            `P-10: CID content mismatch — fetched bytes differ from uploaded bytes for CID ${cid}`
          ),
          { pressCode: 'P-10' }
        );
      }

      return cid;
    },

    async fetchFromIPFS(cid: string): Promise<Uint8Array> {
      return fetchByCid(config.FILEBASE_GATEWAY_URL, cid);
    },

    /**
     * Verify Filebase credentials and bucket access. A HEAD on a
     * non-existent key: 404 means auth worked; any other error is a problem.
     */
    async checkHealth(): Promise<void> {
      let res: Response;
      try {
        res = await aws.fetch(objectUrl('__health_check__'), { method: 'HEAD' });
      } catch (err) {
        throw new Error(
          `Filebase health check failed for bucket "${config.FILEBASE_BUCKET}": ${String(err)}`
        );
      }
      // 404 is fine — it means we reached Filebase and authenticated.
      if (res.status === 404 || res.ok) return;
      throw new Error(
        `Filebase health check failed for bucket "${config.FILEBASE_BUCKET}": HTTP ${res.status}`
      );
    },
  };
}

/**
 * Upload content and retrieve the Filebase-assigned IPFS CID from the
 * `x-amz-meta-cid` response header. Two round trips (PUT + HEAD) is
 * reliable and mirrors S3's object-metadata model exactly (S3 metadata is
 * literally exposed on the wire as `x-amz-meta-<key>` headers, so reading
 * it directly off a HEAD response is equivalent to the AWS SDK's
 * HeadObjectCommand `Metadata` map, just without the SDK in between).
 */
async function uploadAndCaptureCid(aws: AwsClient, url: string, content: Uint8Array): Promise<string> {
  const putRes = await aws.fetch(url, {
    method: 'PUT',
    body: content as BodyInit,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  if (!putRes.ok) {
    throw new Error(`PUT ${url} failed: HTTP ${putRes.status}`);
  }

  const headRes = await aws.fetch(url, { method: 'HEAD' });
  if (!headRes.ok) {
    throw new Error(`HEAD ${url} failed: HTTP ${headRes.status}`);
  }
  const cid = headRes.headers.get('x-amz-meta-cid');
  if (!cid) {
    throw new Error(`Filebase did not return an IPFS CID for object ${url}`);
  }
  return cid;
}

async function fetchByCid(gatewayUrl: string, cid: string): Promise<Uint8Array> {
  const url = `${gatewayUrl}/ipfs/${cid}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`IPFS gateway fetch failed: ${cid} → HTTP ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', data as unknown as BufferSource);
  return Buffer.from(hash).toString('hex');
}
