import { hpkeSeal, type HpkeKeyConfig } from '../crypto/hpke.js';
import { bytesToBase64Url, base64UrlToBytes } from '../util/base64url.js';
import type {
  ObliviousProtocolTransport,
  ObliviousDestination,
  RequestOptions,
  ObliviousResponse,
} from '../providers/ObliviousProtocolTransport.js';

/**
 * Default implementation of `ObliviousProtocolTransport` (Step 1.4a):
 * HPKE-encapsulates every non-bypassed request to the destination's
 * published OHTTP key configuration, POSTs the opaque blob to the relay's
 * oblivious-forwarding endpoint (Step 1.4b), and decapsulates the
 * response. Implemented once here — platform-independent, no web/RN
 * variant needed (per Step 1.2's design).
 *
 * Wire shapes (all JSON over plain HTTPS to the relay — see
 * `relay/server/api/ohttp/[target_id].post.ts`):
 *
 * - `GET {destinationBaseUrl}/ohttp/key-config` →
 *   `{ kemId, kdfId, aeadId, publicKey: base64url, targetId: string }`.
 *   `targetId` is the relay-registry key this destination is registered
 *   under (Step 1.4b) — bundling it into the key-config response means the
 *   client never needs separate, out-of-band relay-target configuration
 *   for a press it hasn't talked to before (OQ-SDK-4's "resolves and
 *   caches each relevant press's OHTTP key configuration and
 *   relay-registration target on demand").
 * - `POST {relayBaseUrl}/ohttp/{targetId}` body:
 *   `{ enc: base64url, ciphertext: base64url }` → response body
 *   `{ nonce: base64url, ciphertext: base64url }` (see `crypto/hpke.ts`
 *   for why the response uses a derived AES-GCM key rather than a second
 *   HPKE encapsulation).
 * - The sealed envelope itself (before encryption) is
 *   `{ path, method, headers, body: base64url | undefined }`; the sealed
 *   response is `{ status, headers, body: base64url | undefined }`.
 */
export interface HpkeObliviousProtocolTransportOptions {
  relayBaseUrl: string;
  walletServiceBaseUrl: string;
  /** Injectable for testing; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** How long a fetched key config is cached before being re-fetched. Default 5 minutes. */
  keyConfigTtlMs?: number;
}

interface KeyConfigCacheEntry {
  config: HpkeKeyConfig;
  targetId: string;
  fetchedAt: number;
}

interface SealedEnvelope {
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

interface SealedResponseEnvelope {
  status: number;
  headers: Record<string, string>;
  body?: string;
}

const DEFAULT_KEY_CONFIG_TTL_MS = 5 * 60 * 1000;

export class HpkeObliviousProtocolTransport implements ObliviousProtocolTransport {
  readonly #relayBaseUrl: string;
  readonly #walletServiceBaseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #keyConfigTtlMs: number;
  readonly #keyConfigCache = new Map<string, KeyConfigCacheEntry>();

  constructor(options: HpkeObliviousProtocolTransportOptions) {
    this.#relayBaseUrl = options.relayBaseUrl.replace(/\/$/, '');
    this.#walletServiceBaseUrl = options.walletServiceBaseUrl.replace(/\/$/, '');
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#keyConfigTtlMs = options.keyConfigTtlMs ?? DEFAULT_KEY_CONFIG_TTL_MS;
  }

  async request(
    destination: ObliviousDestination,
    options: RequestOptions
  ): Promise<ObliviousResponse> {
    const destinationBaseUrl = this.#resolveBaseUrl(destination);

    if (options.bypass) {
      return this.#directRequest(destinationBaseUrl, options);
    }

    const { config, targetId } = await this.#getKeyConfig(destinationBaseUrl);

    const envelope: SealedEnvelope = {
      path: options.path,
      method: options.method,
      headers: options.headers ?? {},
      ...(options.body ? { body: bytesToBase64Url(options.body) } : {}),
    };
    const plaintext = new TextEncoder().encode(JSON.stringify(envelope));

    const { request, openResponse } = await hpkeSeal(config.publicKey, plaintext);

    const relayResponse = await this.#fetch(`${this.#relayBaseUrl}/ohttp/${targetId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enc: bytesToBase64Url(request.enc),
        ciphertext: bytesToBase64Url(request.ciphertext),
      }),
    });

    if (!relayResponse.ok) {
      throw new Error(`ObliviousProtocolTransport: relay returned ${relayResponse.status}`);
    }

    const relayBody = (await relayResponse.json()) as { nonce: string; ciphertext: string };
    const responsePlaintext = await openResponse({
      nonce: base64UrlToBytes(relayBody.nonce),
      ciphertext: base64UrlToBytes(relayBody.ciphertext),
    });
    const responseEnvelope = JSON.parse(
      new TextDecoder().decode(responsePlaintext)
    ) as SealedResponseEnvelope;

    return {
      status: responseEnvelope.status,
      headers: responseEnvelope.headers ?? {},
      body: responseEnvelope.body ? base64UrlToBytes(responseEnvelope.body) : new Uint8Array(),
    };
  }

  async #directRequest(baseUrl: string, options: RequestOptions): Promise<ObliviousResponse> {
    const response = await this.#fetch(`${baseUrl}${options.path}`, {
      method: options.method,
      ...(options.headers ? { headers: options.headers } : {}),
      ...(options.body ? { body: new Uint8Array(options.body) } : {}),
    });
    const body = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, headers: Object.fromEntries(response.headers), body };
  }

  async #getKeyConfig(baseUrl: string): Promise<KeyConfigCacheEntry> {
    const cached = this.#keyConfigCache.get(baseUrl);
    if (cached && Date.now() - cached.fetchedAt < this.#keyConfigTtlMs) {
      return cached;
    }

    const response = await this.#fetch(`${baseUrl}/ohttp/key-config`);
    if (!response.ok) {
      throw new Error(
        `ObliviousProtocolTransport: failed to fetch OHTTP key config from ${baseUrl} (${response.status})`
      );
    }
    const json = (await response.json()) as {
      kemId: number;
      kdfId: number;
      aeadId: number;
      publicKey: string;
      targetId: string;
    };
    const entry: KeyConfigCacheEntry = {
      config: {
        kemId: json.kemId,
        kdfId: json.kdfId,
        aeadId: json.aeadId,
        publicKey: base64UrlToBytes(json.publicKey),
      },
      targetId: json.targetId,
      fetchedAt: Date.now(),
    };
    this.#keyConfigCache.set(baseUrl, entry);
    return entry;
  }

  #resolveBaseUrl(destination: ObliviousDestination): string {
    return destination.kind === 'wallet_service'
      ? this.#walletServiceBaseUrl
      : destination.baseUrl.replace(/\/$/, '');
  }
}
