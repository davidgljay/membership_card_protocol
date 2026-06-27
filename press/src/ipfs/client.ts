/**
 * IPFS pinning client backed by Filebase (S3-compatible object storage).
 *
 * Filebase pins every uploaded object to IPFS and returns the CID in the
 * `x-amz-meta-cid` response header. Content is publicly accessible through
 * the Filebase IPFS gateway (default: https://ipfs.filebase.io/ipfs/<cid>)
 * and any other IPFS gateway.
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

import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import type { PressConfig } from '../config.js';

const FILEBASE_ENDPOINT = 'https://s3.filebase.com';
const FILEBASE_REGION = 'us-east-1';

export interface IpfsClient {
  pinToIPFS(content: Uint8Array): Promise<string>;
  fetchFromIPFS(cid: string): Promise<Uint8Array>;
}

export function createIpfsClient(config: PressConfig): IpfsClient {
  const s3 = new S3Client({
    endpoint: FILEBASE_ENDPOINT,
    region: FILEBASE_REGION,
    credentials: {
      accessKeyId: config.FILEBASE_KEY,
      secretAccessKey: config.FILEBASE_SECRET,
    },
    forcePathStyle: true,
  });

  return {
    async pinToIPFS(content: Uint8Array): Promise<string> {
      // Use a content-hash-derived key so identical content maps to the same
      // S3 object (idempotent uploads). The key is hex of the first 16 bytes
      // of SHA-256(content) — unambiguous within a single press deployment.
      const keyHash = await sha256Hex(content);
      const key = `press/${keyHash.slice(0, 32)}`;

      let cid: string;
      try {
        cid = await uploadAndCaptureCid(s3, config.FILEBASE_BUCKET, key, content);
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
  };
}

/**
 * Upload `content` to Filebase and return the IPFS CID.
 *
 * Filebase returns the CID in the `x-amz-meta-cid` response header on
 * PutObject. We capture it via an AWS SDK v3 middleware. If the header is
 * absent (shouldn't happen with Filebase, but defensive), we fall back to
 * a HeadObject call which returns it in object metadata.
 */
async function uploadAndCaptureCid(
  s3: S3Client,
  bucket: string,
  key: string,
  content: Uint8Array
): Promise<string> {
  let cidFromHeader: string | undefined;

  // Middleware runs after deserialization; captures the raw HTTP response header.
  const handler = s3.middlewareStack.resolve(
    (next) => async (args) => {
      const result = await next(args);
      const httpResponse = result.response as {
        headers?: Record<string, string>;
      };
      if (httpResponse?.headers) {
        cidFromHeader = httpResponse.headers['x-amz-meta-cid'];
      }
      return result;
    },
    { step: 'deserialize', priority: 'low', name: 'captureFilecoinCid' }
  );

  await handler(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: content,
      ContentType: 'application/octet-stream',
    })
  );

  if (cidFromHeader) {
    return cidFromHeader;
  }

  // Fallback: HeadObject returns the CID in Metadata.cid
  const head = await s3.send(
    new HeadObjectCommand({ Bucket: bucket, Key: key })
  );
  const cid = head.Metadata?.['cid'];
  if (!cid) {
    throw new Error(
      `Filebase did not return an IPFS CID for object ${key} in bucket ${bucket}`
    );
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
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Buffer.from(hash).toString('hex');
}

/**
 * Verify Filebase credentials and bucket access at startup.
 * Called during startup before the press opens its HTTP listener.
 */
export async function checkFilebaseHealth(config: PressConfig): Promise<void> {
  const s3 = new S3Client({
    endpoint: FILEBASE_ENDPOINT,
    region: FILEBASE_REGION,
    credentials: {
      accessKeyId: config.FILEBASE_KEY,
      secretAccessKey: config.FILEBASE_SECRET,
    },
    forcePathStyle: true,
  });

  // HeadObject on a non-existent key: 404 means auth worked; any other error is a problem.
  try {
    await s3.send(
      new HeadObjectCommand({ Bucket: config.FILEBASE_BUCKET, Key: '__health_check__' })
    );
  } catch (err) {
    const errName = (err as { name?: string }).name;
    // 404 (NotFound) is fine — it means we reached Filebase and authenticated.
    if (errName === 'NotFound' || errName === 'NoSuchKey') return;
    throw new Error(
      `Filebase health check failed for bucket "${config.FILEBASE_BUCKET}": ${String(err)}`
    );
  }
}
