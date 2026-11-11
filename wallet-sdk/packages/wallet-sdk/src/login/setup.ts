/**
 * Setup and discovery for card login (wallet_sdk.md §7a.6–7a.8):
 * server card authorization (site operator's wallet), domain binding (DNS
 * admin's wallet + code 520), login router registration, and services.
 */
import {
  canonicalize,
  mlDsa44Sign,
  mlDsa44Verify,
  bytesToBase64Url,
  base64UrlToBytes,
  keccak256,
  type ObliviousProtocolTransport,
  type RegisterSubCardFn,
  type SecureKeyProvider,
  type SignedSubCardDocument,
  type SubCardDocumentFields,
} from '@membership-card-protocol/app-sdk';
import {
  effectivePreferredServices,
  domainCovers,
  signingBytes,
  type CardVerifier,
  type ChainContext,
  type DomainBindingAttestation,
  type LoginServiceMetadata,
  type PreferredService,
  type WalletRegistrationToken,
  type WalletRegistrationTokenBody,
} from '@membership-card-protocol/verifier';
import { matchMcardQuery } from '@membership-card-protocol/verifier';
import { postCardUpdate, type PostCardUpdateResult } from '../updates/postCardUpdate.js';

const norm = (a: string) => a.toLowerCase().replace(/^0x/, '');

// ─── §7a.6 Server card authorization ────────────────────────────────────────

/**
 * Signs a server card SubCardDocument with the login service card key in both
 * roles (subcards.md §Server Cards), registers it, and posts the code-510
 * active_subcards entry. No consent step: the operator is app and holder.
 */
export async function authorizeServerCard(options: {
  unsignedDocument: SubCardDocumentFields;
  loginServiceCardSecretKey: Uint8Array;
  registerSubCard: RegisterSubCardFn;
  postActiveSubcardAddition: (serverCardPubkey: string) => Promise<unknown>;
}): Promise<{ registered: true; document: SignedSubCardDocument } | { registered: false; code: string; reason: string }> {
  const d = options.unsignedDocument;
  const fail = (code: string, reason: string) => ({ registered: false as const, code, reason });
  if (norm(d.app_card) !== norm(d.holder_primary_card) || d.app_card_pubkey !== d.holder_primary_card_pubkey) {
    return fail('LOGIN_SERVICE_SCOPE', 'a server card must name the login service card as both app_card and holder');
  }
  if (d.attestation_level !== 'S1') return fail('LOGIN_REQUESTER_NOT_SERVER_CARD', 'server cards use attestation_level S1');
  if (!d.capabilities.includes('auth_request')) return fail('LOGIN_REQUESTER_NOT_SERVER_CARD', 'server card needs the auth_request capability');
  if (keccak256(base64UrlToBytes(d.holder_primary_card_pubkey)) !== norm(d.holder_primary_card)) {
    return fail('ADDRESS_BINDING_MISMATCH', 'holder_primary_card_pubkey does not bind to holder_primary_card');
  }
  const appSignature = bytesToBase64Url(mlDsa44Sign(options.loginServiceCardSecretKey, canonicalize(d)));
  const withApp = { ...d, app_signature: appSignature };
  const holderSignature = bytesToBase64Url(mlDsa44Sign(options.loginServiceCardSecretKey, canonicalize(withApp)));
  const document = { ...withApp, holder_signature: holderSignature } as SignedSubCardDocument;
  const result = await options.registerSubCard(document);
  if (!result.registered) return fail('REGISTRATION_FAILED', 'press did not register the server card');
  await options.postActiveSubcardAddition(d.recipient_pubkey);
  return { registered: true, document };
}

// ─── Domain binding (dns_resolution.md §5.3, code 520) ──────────────────────

/** Run by the DNS admin's wallet: signs a DomainBindingAttestation (protocol-objects.md §17). */
export function signDomainBindingAttestation(options: {
  domain: string;
  adminCardSecretKey: Uint8Array;
  adminCardPublicKey: string;
  loginServiceCardPublicKey: string;
  issuedAt?: string;
}): DomainBindingAttestation {
  const domain = options.domain.toLowerCase().replace(/\.$/, '');
  const unsigned = {
    admin_card: keccak256(base64UrlToBytes(options.adminCardPublicKey)),
    admin_card_pubkey: options.adminCardPublicKey,
    domain,
    issued_at: options.issuedAt ?? new Date().toISOString(),
    login_service_card: keccak256(base64UrlToBytes(options.loginServiceCardPublicKey)),
    login_service_card_pubkey: options.loginServiceCardPublicKey,
  };
  return { ...unsigned, admin_signature: bytesToBase64Url(mlDsa44Sign(options.adminCardSecretKey, canonicalize(unsigned))) };
}

/** Run by the site operator's wallet: posts the attestation with code 520 (press.md §5.3 step 4a). */
export async function postDomainBinding(options: {
  transport: ObliviousProtocolTransport;
  pressBaseUrl: string;
  binding: DomainBindingAttestation;
  loginServiceCardSecretKey: Uint8Array;
  loginServiceCardPublicKey: string;
  timestamp?: string;
}): Promise<PostCardUpdateResult> {
  const card = keccak256(base64UrlToBytes(options.loginServiceCardPublicKey));
  return postCardUpdate({
    transport: options.transport,
    pressBaseUrl: options.pressBaseUrl,
    intent: {
      target_card: card,
      updater_card: card,
      code: 520,
      field_updates: [{ field: 'domain_binding', value: options.binding }],
      timestamp: options.timestamp ?? new Date().toISOString(),
      notify_holder: false,
    },
    sign: (m) => mlDsa44Sign(options.loginServiceCardSecretKey, m),
    signerPublicKey: options.loginServiceCardPublicKey,
  });
}

// ─── §7a.7 Login router registration ────────────────────────────────────────

/** Operator tooling: one token per wallet deployment (protocol-objects.md §19). */
export async function signWalletRegistrationToken(options: {
  token: Omit<WalletRegistrationTokenBody, 'version'>;
  appCardKeyId: string;
  keyProvider: SecureKeyProvider;
}): Promise<WalletRegistrationToken> {
  const token: WalletRegistrationTokenBody = { ...options.token, version: '1' };
  const signature = await options.keyProvider.sign(options.appCardKeyId, canonicalize(token));
  return { token, signature: bytesToBase64Url(signature) };
}

/** login_router.md §4 — fragment-only. */
export function routerRegistrationUrl(options: { routerOrigin: string; token: WalletRegistrationToken; next?: string }): string {
  const params = new URLSearchParams({ token: bytesToBase64Url(canonicalize(options.token)) });
  if (options.next) params.set('next', options.next);
  return `${options.routerOrigin.replace(/\/$/, '')}/register#${params.toString()}`;
}

// ─── §7a.8 Services ─────────────────────────────────────────────────────────

export interface EffectiveService extends PreferredService {
  metadata: LoginServiceMetadata;
}

/**
 * card_login.md §Service Discovery: the card's effective preferred_services,
 * keeping only services whose signed /.well-known/membership-login is valid
 * and accepts this card. Display fields come from the policy entry.
 */
export async function resolveEffectiveServices(options: {
  cardFields: Record<string, unknown>;
  /** The card's registry address, so its own policy is read from the chain. */
  cardAddress?: string;
  chain: ChainContext;
  verifier: CardVerifier;
  fetch: typeof globalThis.fetch;
  now?: Date;
}): Promise<EffectiveService[]> {
  const out: EffectiveService[] = [];
  for (const service of await effectivePreferredServices(options.cardFields, options.chain)) {
    const metadata = await fetchServiceMetadata(service.origin, options);
    if (!metadata) continue;
    const accepts = await matchMcardQuery(
      options.cardFields,
      { id: 'service', format: 'mcard', meta: { policies: metadata.metadata.accepts } },
      options.chain,
      options.cardAddress
    );
    if (accepts.matched) out.push({ ...service, metadata });
  }
  return out;
}

async function fetchServiceMetadata(
  origin: string,
  options: { verifier: CardVerifier; fetch: typeof globalThis.fetch; now?: Date }
): Promise<LoginServiceMetadata | null> {
  let doc: LoginServiceMetadata;
  try {
    const res = await options.fetch(`${origin}/.well-known/membership-login`, { credentials: 'omit' });
    if (res.status !== 200) return null;
    doc = (await res.json()) as LoginServiceMetadata;
  } catch {
    return null;
  }
  const m = doc?.metadata;
  if (!m || m.version !== '1' || m.origin !== origin || new URL(m.start_url).origin !== origin) return null;
  if (!domainCovers(new URL(origin).hostname, origin)) return null;
  try {
    const pk = base64UrlToBytes(m.server_card_pubkey);
    if (keccak256(pk) !== norm(m.server_card)) return null;
    if (!mlDsa44Verify(pk, signingBytes(m), base64UrlToBytes(doc.signature))) return null;
  } catch {
    return null;
  }
  const server = await options.verifier.verifyServerCard(m.server_card_pubkey, { origin, now: (options.now ?? new Date()).toISOString() });
  return server.valid ? doc : null;
}
