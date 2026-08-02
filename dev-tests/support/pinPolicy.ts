/**
 * Pins a policy document to the real dev Filebase bucket at test-run time,
 * for suites that need a *freshly*-registered policy rather than the
 * shared pre-provisioned one (`DEV_TESTS_POLICY_ID`/`_ADDRESS`) -- e.g.
 * log_auditing.spec.ts, which needs a distinct `auditors` array per test
 * case. Mirrors press/scripts/pin-dev-policy.mjs's own pinToIPFS logic
 * exactly (PutObject, then HeadObject to read the Filebase-assigned CID,
 * then a gateway re-fetch + byte-compare validation) so the result is
 * guaranteed fetchable the same way press itself will fetch it at
 * issuance time.
 *
 * Requires FILEBASE_KEY/FILEBASE_SECRET/FILEBASE_BUCKET -- the same dev
 * Filebase credentials used to provision the shared pre-provisioned
 * policy (see dev-tests/README.md's "Dev governance prerequisite").
 */

import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { keccak256 } from 'viem';

const FILEBASE_ENDPOINT = process.env['FILEBASE_ENDPOINT'] ?? 'https://s3.filebase.com';
const FILEBASE_REGION = process.env['FILEBASE_REGION'] ?? 'us-east-1';
const FILEBASE_GATEWAY_URL = process.env['DEV_IPFS_GATEWAY_URL'] ?? 'https://ipfs.filebase.io';

let s3Client: S3Client | undefined;

function getS3Client(): S3Client {
  const key = process.env['FILEBASE_KEY'];
  const secret = process.env['FILEBASE_SECRET'];
  if (!key || !secret) {
    throw new Error(
      'pinPolicy: FILEBASE_KEY / FILEBASE_SECRET are not set -- see dev-tests/.env.example.',
    );
  }
  if (!s3Client) {
    s3Client = new S3Client({
      endpoint: FILEBASE_ENDPOINT,
      region: FILEBASE_REGION,
      credentials: { accessKeyId: key, secretAccessKey: secret },
      forcePathStyle: true,
    });
  }
  return s3Client;
}

export interface PinnedPolicy {
  policyId: string; // the CID
  policyAddress: `0x${string}`; // keccak256 of the pinned bytes
}

/** Pins an arbitrary JSON document (a policy card) to real dev Filebase, returning its CID and on-chain address. */
export async function pinPolicyDocument(policyDocument: unknown): Promise<PinnedPolicy> {
  const bucket = process.env['FILEBASE_BUCKET'];
  if (!bucket) {
    throw new Error('pinPolicy: FILEBASE_BUCKET is not set -- see dev-tests/.env.example.');
  }
  const s3 = getS3Client();
  const content = new TextEncoder().encode(JSON.stringify(policyDocument));

  const keyHash = Buffer.from(await crypto.subtle.digest('SHA-256', content)).toString('hex');
  const key = `dev-tests/${keyHash.slice(0, 32)}`;

  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: content, ContentType: 'application/octet-stream' }));

  const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  const cid = head.Metadata?.['cid'];
  if (!cid) {
    throw new Error('pinPolicy: Filebase did not return an IPFS CID (no "cid" metadata on the uploaded object).');
  }

  const fetchRes = await fetch(`${FILEBASE_GATEWAY_URL}/ipfs/${cid}`);
  if (!fetchRes.ok) {
    throw new Error(`pinPolicy: CID validation fetch failed: HTTP ${fetchRes.status}`);
  }
  const fetched = new Uint8Array(await fetchRes.arrayBuffer());
  const matches = fetched.length === content.length && fetched.every((b, i) => b === content[i]);
  if (!matches) {
    throw new Error('pinPolicy: fetched bytes differ from uploaded bytes -- do not use this CID.');
  }

  const policyAddress = keccak256(content);
  return { policyId: cid, policyAddress };
}
