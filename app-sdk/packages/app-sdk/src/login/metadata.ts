/** /.well-known/membership-login (app_sdk.md §9a.4, protocol-objects.md §18). */
import type { LoginServiceMetadata, LoginServiceMetadataBody, McardPolicyRef, ResponseMode } from '@membership-card-protocol/verifier';
import { canonicalize } from '../crypto/canonicalize.js';
import { bytesToBase64Url } from '../util/base64url.js';
import type { SecureKeyProvider } from '../providers/SecureKeyProvider.js';
import type { ServerCardIdentity } from './request.js';

export async function buildLoginServiceMetadata(options: {
  origin: string;
  name: string;
  startUrl: string;
  accepts: McardPolicyRef[];
  responseModes: ResponseMode[];
  server: ServerCardIdentity;
  keyProvider: SecureKeyProvider;
  updatedAt?: string;
}): Promise<LoginServiceMetadata> {
  const origin = new URL(options.origin).origin;
  if (origin !== options.origin || !origin.startsWith('https://')) throw new Error('buildLoginServiceMetadata: origin must be an https origin');
  if (new URL(options.startUrl).origin !== origin) throw new Error('buildLoginServiceMetadata: startUrl must be on the same origin');
  const metadata: LoginServiceMetadataBody = {
    accepts: options.accepts,
    name: options.name,
    origin,
    response_modes: options.responseModes,
    server_card: options.server.pointer,
    server_card_pubkey: options.server.pubkey,
    start_url: options.startUrl,
    updated_at: options.updatedAt ?? new Date().toISOString(),
    version: '1',
  };
  const signature = await options.keyProvider.sign(options.server.keyId, canonicalize(metadata));
  return { metadata, signature: bytesToBase64Url(signature) };
}
