/**
 * chitt-validator
 *
 * Validates signed message envelopes (§6) per the Chitt Protocol (v0.3).
 *
 * @example
 * ```ts
 * import { validateChitt } from 'chitt-validator';
 *
 * const result = await validateChitt(envelope, {
 *   trustedRoots: ['<authorizer-registry-address>'],
 *   verifierChitt: '<my-chitt-pointer>',
 *   ipfsGateway: 'https://ipfs.io',
 *   registryContractAddress: '<deployed-contract-address>',
 * });
 *
 * console.log(result.valid);         // true | false
 * console.log(result.policy);        // 'ipfs://...'
 * console.log(result.authorizer);    // 'ipfs://...'
 * console.log(result.policyCreator); // 'ipfs://...'
 * console.log(result.chains);        // ValidationChains | null
 * ```
 */

import type {
  ChittProvider,
  SignedMessageEnvelope,
  ValidationOptions,
  ValidationResult,
} from './types.js';
import { HttpChittProvider } from './provider.js';
import {
  verifySignatureEntry,
  resolvePointerToIpfsUrl,
  resolveValidationChains,
} from './verify.js';

export type {
  SignedMessageEnvelope,
  MessagePayload,
  SignatureEntry,
  ChittDocument,
  LogEntry,
  LogEntryWithCid,
  RevocationEntry,
  SubChittRegistration,
  SignatureResult,
  ChainUpdate,
  PolicyChainLink,
  ValidationChains,
  ValidationResult,
  ValidationOptions,
  ChittProvider,
} from './types.js';

export { canonicalize, base64urlDecode, base64urlEncode, toHex, fromHex } from './serialization.js';

export { HttpChittProvider } from './provider.js';

export { walkPolicyCreationChain } from './verify.js';

/**
 * Validate a signed message envelope (§6) per the full §7 verification flow.
 *
 * Performs per-signature:
 *   1. ML-DSA-44 signature verification over the canonical CBOR payload
 *   2. Sub-chitt → master chitt resolution (Arbitrum One)
 *   3. Historical chain walk (IPFS)
 *   4. Current revocation check (Arbitrum One + IPFS log)
 *   5. Recipient-set check
 *
 * Returns a `valid` boolean, per-signature details, ipfs:// URLs for
 * the policy, press, and policy creator, and three policy creation chains
 * with the full update history of every chitt encountered.
 *
 * **Note:** On-chain reads require the Chitt registry contract to be deployed.
 * Until then, pass a custom `provider` in options for testing, or expect errors
 * from the default provider's getLogHead / getSubChittRegistration methods.
 */
export async function validateChitt(
  envelope: SignedMessageEnvelope,
  options: ValidationOptions = {},
): Promise<ValidationResult> {
  const {
    trustedRoots = [],
    verifierChitt,
    freshnessWindowSeconds = 300,
    ipfsGateway,
    arbitrumRpcUrl,
    registryContractAddress,
  } = options;

  const provider: ChittProvider =
    options.provider ??
    new HttpChittProvider({ ipfsGateway, arbitrumRpcUrl, registryContractAddress });

  const signingTimeMs = Date.parse(envelope.payload.timestamp);
  if (isNaN(signingTimeMs)) {
    return {
      valid: false,
      authorizer: null,
      policy: null,
      policyCreator: null,
      signatures: [],
      chains: null,
    };
  }

  // Run all signature verifications in parallel (§7 stage 3 uses parallel IPFS fetches)
  const outputs = await Promise.all(
    envelope.signatures.map(entry =>
      verifySignatureEntry(entry, {
        provider,
        trustedRoots,
        verifierChitt,
        freshnessWindowSeconds,
        payload: envelope.payload,
        signingTimeMs,
      }),
    ),
  );

  const signatureResults = outputs.map(o => o.result);

  // Overall validity: all signatures must be cryptographically valid,
  // reach a trusted root, and have been valid at signing time.
  const valid =
    signatureResults.length > 0 &&
    signatureResults.every(
      r => r.signature_valid && r.chain_reaches_trusted_root && r.was_valid_at_signing_time,
    );

  // Collect links from the first successfully resolved signature.
  // All signatures on a well-formed envelope should resolve to the same policy.
  const firstResolved = outputs.find(
    o => o.masterChittAddress !== null,
  );

  const policyCid = firstResolved?.policyCid ?? null;
  const pressPointer = firstResolved?.pressChittPointer ?? null;
  const policyCreatorPointer = firstResolved?.policyCreatorPointer ?? null;
  const masterChittAddress = firstResolved?.masterChittAddress ?? null;

  // Resolve mutable pointers to ipfs:// URLs and walk the three policy creation chains.
  const [authorizer, policyCreator, chains] = await Promise.all([
    pressPointer ? resolvePointerToIpfsUrl(pressPointer, provider) : Promise.resolve(null),
    policyCreatorPointer
      ? resolvePointerToIpfsUrl(policyCreatorPointer, provider)
      : Promise.resolve(null),
    resolveValidationChains(masterChittAddress, pressPointer, policyCreatorPointer, provider).catch(
      () => null,
    ),
  ]);

  const policy = policyCid ? `ipfs://${policyCid}` : null;

  return {
    valid,
    authorizer,
    policy,
    policyCreator,
    signatures: signatureResults,
    chains,
  };
}
