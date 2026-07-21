import { canonicalize } from "./canonicalize.js";
import { PROTOCOL_VERSION_0_1 } from "./constants.js";
import { keccak256, hkdfSha3256, aes256gcmDecrypt, base64UrlToBytes } from "./crypto.js";
import { CardProtocolError } from "./errors.js";
import { evaluatePolicyMatch } from "./policy-match.js";
import { verifyStage1 } from "./stages/stage1.js";
import { verifyStage2 } from "./stages/stage2.js";
import { verifyStage3 } from "./stages/stage3.js";
import type { ChainLink } from "./stages/stage3.js";
import { verifyStage4 } from "./stages/stage4.js";
import { verifyStage5 } from "./stages/stage5.js";
import { verifyStage6 } from "./stages/stage6.js";
import { extractProtocolVersion } from "./version.js";
import type {
  VerifierConfig,
  SignedMessageEnvelope,
  EnvelopeVerificationResult,
  SignatureVerificationResult,
  CardVerificationResult,
  VerifyCardOptions,
  VerificationError,
  PolicyMatchResult,
  CardDocument,
} from "./types.js";

const DEFAULTS = {
  trustedRoots: [] as string[],
  revocationFreshnessWindowSeconds: 300,
  rejectStaleRevocation: true,
  maxChainDepth: 64,
  fetchAnnotations: false,
  additionalAnnotators: [] as string[],
  returnChain: false,
} as const;

export class CardVerifier {
  private readonly config: Required<
    Omit<VerifierConfig, "registryEndpoint" | "conditions" | "appCertificationRoot">
  > & {
    registryEndpoint: string | undefined;
    conditions: VerifierConfig["conditions"];
    appCertificationRoot: string | undefined;
  };

  constructor(config: VerifierConfig) {
    if (!config.rpc) {
      throw new CardProtocolError("MISSING_RPC_PROVIDER", "VerifierConfig.rpc is required");
    }
    if (!config.ipfs) {
      throw new CardProtocolError("MISSING_IPFS_PROVIDER", "VerifierConfig.ipfs is required");
    }
    // appCertificationRoot is intentionally NOT required here — it is only needed
    // whenever this verifier instance actually encounters a sub-card signature.
    // Stage 2 hard-rejects with APP_CERTIFICATION_ROOT_NOT_CONFIGURED at the point
    // it would otherwise attempt the app-cert chain walk, if this is unset.
    this.config = {
      rpc: config.rpc,
      ipfs: config.ipfs,
      appCertificationRoot: config.appCertificationRoot,
      trustedRoots: config.trustedRoots ?? DEFAULTS.trustedRoots,
      revocationFreshnessWindowSeconds:
        config.revocationFreshnessWindowSeconds ?? DEFAULTS.revocationFreshnessWindowSeconds,
      rejectStaleRevocation: config.rejectStaleRevocation ?? DEFAULTS.rejectStaleRevocation,
      maxChainDepth: config.maxChainDepth ?? DEFAULTS.maxChainDepth,
      registryEndpoint: config.registryEndpoint,
      fetchAnnotations: config.fetchAnnotations ?? DEFAULTS.fetchAnnotations,
      additionalAnnotators: config.additionalAnnotators ?? DEFAULTS.additionalAnnotators,
      returnChain: config.returnChain ?? DEFAULTS.returnChain,
      conditions: config.conditions,
    };
  }

  async verifyEnvelope(
    envelope: SignedMessageEnvelope
  ): Promise<EnvelopeVerificationResult> {
    const verified_at = new Date().toISOString();

    let protocol_version: string;
    try {
      protocol_version = extractProtocolVersion(envelope.payload);
    } catch (e) {
      if (e instanceof CardProtocolError) {
        const raw = envelope.payload.protocol_version;
        const ver = typeof raw === "string" ? raw : "unknown";
        const earlyPolicyMatch = evaluatePolicyMatch([], this.config.conditions);
        const earlySignature: SignatureVerificationResult = {
          signer_card: "",
          signature_valid: false,
          scope_clean: "skipped",
          chain_reaches_trusted_root: "skipped",
          chain_card_addresses: [],
          app_card_chain_valid: "skipped",
          revocation: { status: "unknown", code: null, effective_date: null, data_freshness_seconds: 0 },
          was_valid_at_signing_time: "skipped",
          is_currently_valid: "skipped",
          log_updates: [],
          policy_compliant: "skipped",
          policy_match: earlyPolicyMatch,
          press_subsequently_revoked: false,
          non_compliance_reported: false,
          addressed_to_verifier: false,
          errors: [{ stage: 1, code: e.code, message: e.message }],
          annotations: [],
          ...(this.config.returnChain ? { chain: [] } : {}),
        };
        return {
          envelope_id: "",
          verified_at,
          protocol_version: ver,
          signatures: [earlySignature],
          policy_match: this.#aggregateEnvelopePolicyMatch([earlySignature]),
        };
      }
      throw e;
    }

    const canonicalEnvelope = canonicalize(envelope);
    const envelopeIdDigest = await crypto.subtle.digest("SHA-256", Uint8Array.from(canonicalEnvelope));
    const envelope_id = Buffer.from(envelopeIdDigest).toString("hex");

    const signatures = await Promise.all(
      envelope.signatures.map((entry) =>
        this.#verifySignatureEntry(entry, envelope.payload, envelope.payload.timestamp)
      )
    );

    return {
      envelope_id,
      verified_at,
      protocol_version,
      signatures,
      policy_match: this.#aggregateEnvelopePolicyMatch(signatures),
    };
  }

  async verifyCard(
    cardAddress: string,
    options?: VerifyCardOptions
  ): Promise<CardVerificationResult> {
    const signingTimestamp = options?.asOf ?? new Date().toISOString();
    const errors: VerificationError[] = [];

    // Stage 1 is skipped for verifyCard
    // Stage 2: fetch card entry and master card doc starting from the given address
    const cardEntry = await this.config.rpc.getCardEntry(cardAddress);
    if (!cardEntry || !cardEntry.exists) {
      return this.#skippedResult(cardAddress, [
        { stage: 2, code: "CARD_NOT_FOUND", message: `Card not found: ${cardAddress}` },
      ]);
    }

    // For verifyCard, we skip the sub-card doc path and go straight to the chain walk.
    // We need the card's CardDocument to start the chain walk.
    // The card IS the "master" card — derive content key from recipient_pubkey (unknown here).
    // Per spec §6.2: Stage 2 is skipped (scope_clean: "skipped"), start from Stage 3 directly.
    // We still need a CardDocument to pass to Stage 3. We fetch log_head_cid from IPFS,
    // but we can't decrypt it without the pubkey. So we use a fallback: for verifyCard,
    // scope_clean is "skipped" and we synthesize a minimal doc from on-chain data.
    // Stage 3 chain walk requires ancestry_pubkeys from the card doc, which means we
    // need the pubkey. For verifyCard, we accept the chain walk starting from the card
    // directly — if the card itself is a trusted root, chain_reaches_trusted_root = true.

    const isTrustedRoot =
      this.config.trustedRoots.includes(cardAddress) ||
      (await this.config.rpc.isPolicyAuthorizer(cardAddress));

    // Stage 3 result: simplified chain for verifyCard (can't walk without pubkey)
    const chainAddresses = [cardAddress];

    // Stage 4: revocation check. verifyCard has no pubkey, so no card_content can
    // ever be decrypted here — Stage 4 falls back to `revocation.status: "unknown"`
    // for this path (see card_verifier.md §7.4 "verifyCard limitation").
    const stage4 = await verifyStage4(
      [{ card_address: cardAddress, public_key: "", card_content: {} }],
      signingTimestamp,
      this.config.rpc,
      this.config
    );

    // Stage 6: annotations
    const stage6 = await verifyStage6(chainAddresses, this.config.rpc, this.config.ipfs, this.config);

    const allErrors = [...errors, ...stage4.errors, ...stage6.errors];

    // verifyCard cannot decrypt any CardDocument (no pubkey available for the given
    // address alone), so no chain data is ever resolved here — chain is always empty.
    let chain: ChainLink[] = [];
    let realChainReachesTrustedRoot: boolean | "skipped" = isTrustedRoot;
    let realChainAddresses: string[] = chainAddresses;

    if (options?.pubkey) {
      const pubkeyBytes = base64UrlToBytes(options.pubkey);
      const derivedAddress = keccak256(pubkeyBytes);

      if (derivedAddress !== cardAddress) {
        allErrors.push({
          stage: 3,
          code: "ADDRESS_BINDING_MISMATCH",
          message: `Supplied pubkey does not correspond to cardAddress: ${cardAddress}`,
        });
        // chain stays [], realChainReachesTrustedRoot stays isTrustedRoot (today's behavior)
      } else {
        const contentKey = hkdfSha3256(pubkeyBytes, "card-content-v1");
        try {
          const encrypted = await this.config.ipfs.fetch(cardEntry.log_head_cid);
          const decrypted = await aes256gcmDecrypt(contentKey, encrypted);
          const cardDoc = JSON.parse(new TextDecoder().decode(decrypted)) as CardDocument;

          const stage3 = await verifyStage3(cardDoc, cardAddress, this.config.rpc, this.config.ipfs, this.config, pubkeyBytes);
          allErrors.push(...stage3.errors);
          chain = stage3.chain;
          realChainReachesTrustedRoot = stage3.chain_reaches_trusted_root;
          realChainAddresses = stage3.chain_card_addresses;
        } catch (e) {
          const code = e instanceof CardProtocolError ? e.code : "DECRYPTION_FAILED";
          allErrors.push({ stage: 3, code, message: String(e) });
          // chain stays [] — decryption/parse failure falls back to today's behavior,
          // not a hard rejection of the whole verifyCard call.
        }
      }
    }

    return {
      signer_card: cardAddress,
      signature_valid: null,
      protocol_version: PROTOCOL_VERSION_0_1,
      scope_clean: "skipped",
      chain_reaches_trusted_root: realChainReachesTrustedRoot,
      chain_card_addresses: realChainAddresses,
      app_card_chain_valid: "skipped",
      revocation: stage4.revocation,
      was_valid_at_signing_time: stage4.was_valid_at_signing_time,
      is_currently_valid: stage4.is_currently_valid,
      log_updates: stage4.log_updates,
      policy_compliant: "skipped",
      policy_match: evaluatePolicyMatch(chain, this.config.conditions),
      press_subsequently_revoked: false,
      non_compliance_reported: false,
      addressed_to_verifier: false,
      errors: allErrors,
      annotations: stage6.annotations,
      ...(this.config.returnChain ? { chain } : {}),
    };
  }

  async #verifySignatureEntry(
    entry: { public_key: string; signature: string },
    payload: SignedMessageEnvelope["payload"],
    signingTimestamp: string
  ): Promise<SignatureVerificationResult> {
    const errors: VerificationError[] = [];

    // Stage 1
    let publicKeyBytes: Uint8Array;
    let signatureValid: boolean;
    try {
      const s1 = verifyStage1(entry, payload);
      publicKeyBytes = s1.public_key_bytes;
      signatureValid = s1.signature_valid;
    } catch (e) {
      if (e instanceof CardProtocolError) throw e;
      throw e;
    }

    const signerCard = keccak256(publicKeyBytes);

    // Stage 2
    const stage2 = await verifyStage2(publicKeyBytes, this.config.rpc, this.config.ipfs, {
      appCertificationRoot: this.config.appCertificationRoot,
      maxChainDepth: this.config.maxChainDepth,
    });
    errors.push(...stage2.errors);

    if (stage2.scope_clean === false && !stage2.master_card_doc) {
      // Hard rejection: skip stages 3–5. No CardDocument was ever resolved, so
      // there is no chain data to compute policy_match from beyond "not found".
      return this.#buildResult(signerCard, signatureValid, stage2.scope_clean, "skipped", stage2.app_card_chain_valid, errors, {
        revocation: { status: "unknown", code: null, effective_date: null, data_freshness_seconds: 0 },
        was_valid_at_signing_time: "skipped",
        is_currently_valid: "skipped",
        log_updates: [],
        policy_compliant: "skipped",
        chain: [],
      });
    }

    // Stage 3
    // The walk starts from the master card's own document, so it must also start from
    // the master card's own address — not stage2.signer_card, which identifies the
    // sub-card that actually signed (used below for the result's signer_card field).
    // A sub-card has no ancestry of its own; only the master does.
    const startDoc = stage2.master_card_doc!;
    const startPubkey = stage2.master_card_pubkey!;
    const startAddress = keccak256(startPubkey);
    const stage3 = await verifyStage3(
      startDoc,
      startAddress,
      this.config.rpc,
      this.config.ipfs,
      this.config,
      startPubkey
    );
    errors.push(...stage3.errors);

    if (stage3.chain_reaches_trusted_root === false && stage3.errors.some((e) => e.code === "DECRYPTION_FAILED" || e.code === "ADDRESS_BINDING_MISMATCH")) {
      // Hard rejection mid-chain: skip stages 4–5. stage3.chain is partial (as far as
      // the walk got before the failure) — still exposed/used per the plan's decision
      // to keep partial chains rather than discard them.
      return this.#buildResult(signerCard, signatureValid, stage2.scope_clean, stage3.chain_reaches_trusted_root, stage2.app_card_chain_valid, errors, {
        revocation: { status: "unknown", code: null, effective_date: null, data_freshness_seconds: 0 },
        was_valid_at_signing_time: "skipped",
        is_currently_valid: "skipped",
        log_updates: [],
        policy_compliant: "skipped",
        chain: stage3.chain,
      });
    }

    // Stage 4. Reuses Stage 3's already-fetched-and-decrypted `chain` (no second
    // IPFS fetch pass) — see stage4.ts's doc comment for how content + the
    // on-chain event-log replay are combined.
    const stage4 = await verifyStage4(
      stage3.chain,
      signingTimestamp,
      this.config.rpc,
      this.config
    );
    errors.push(...stage4.errors);

    // Stage 5
    const cardEntry = await this.config.rpc.getCardEntry(signerCard);
    let policyCompliant: boolean | null | "skipped" = "skipped";
    let pressSubsequentlyRevoked = false;
    let nonComplianceReported = false;

    if (cardEntry?.exists) {
      const rawBytes = await this.config.ipfs.fetch(cardEntry.log_head_cid);
      const stage5 = await verifyStage5(
        startDoc,
        cardEntry,
        signerCard,
        cardEntry.log_head_cid,
        rawBytes,
        this.config.rpc,
        this.config.ipfs,
        { registryEndpoint: this.config.registryEndpoint }
      );
      errors.push(...stage5.errors);
      policyCompliant = stage5.policy_compliant;
      pressSubsequentlyRevoked = stage5.press_subsequently_revoked;
      nonComplianceReported = stage5.non_compliance_reported;
    }

    // policy_match: computed from Stage 3's already-walked chain data (Task 1) —
    // no second chain walk or IPFS fetch pass, per the plan's "avoid reproducing
    // logic" decision. Computed regardless of `returnChain`, which only controls
    // whether the chain itself is exposed on the result.
    const policyMatch = evaluatePolicyMatch(stage3.chain, this.config.conditions);

    // Stage 6
    const stage6 = await verifyStage6(
      stage3.chain_card_addresses,
      this.config.rpc,
      this.config.ipfs,
      this.config
    );
    errors.push(...stage6.errors);

    return {
      signer_card: signerCard,
      signature_valid: signatureValid,
      scope_clean: stage2.scope_clean,
      chain_reaches_trusted_root: stage3.chain_reaches_trusted_root,
      chain_card_addresses: stage3.chain_card_addresses,
      app_card_chain_valid: stage2.app_card_chain_valid,
      revocation: stage4.revocation,
      was_valid_at_signing_time: stage4.was_valid_at_signing_time,
      is_currently_valid: stage4.is_currently_valid,
      log_updates: stage4.log_updates,
      policy_compliant: policyCompliant,
      policy_match: policyMatch,
      press_subsequently_revoked: pressSubsequentlyRevoked,
      non_compliance_reported: nonComplianceReported,
      addressed_to_verifier: false,
      errors,
      annotations: stage6.annotations,
      ...(this.config.returnChain ? { chain: stage3.chain } : {}),
    };
  }

  #buildResult(
    signerCard: string,
    signatureValid: boolean,
    scopeClean: boolean | "skipped",
    chainReachesTrustedRoot: boolean | "skipped",
    appCardChainValid: boolean | "skipped",
    errors: VerificationError[],
    overrides: {
      revocation: SignatureVerificationResult["revocation"];
      was_valid_at_signing_time: boolean | "skipped";
      is_currently_valid: boolean | "skipped";
      log_updates: SignatureVerificationResult["log_updates"];
      policy_compliant: boolean | null | "skipped";
      chain: ChainLink[];
    }
  ): SignatureVerificationResult {
    return {
      signer_card: signerCard,
      signature_valid: signatureValid,
      scope_clean: scopeClean,
      chain_reaches_trusted_root: chainReachesTrustedRoot,
      chain_card_addresses: overrides.chain.map((link) => link.card_address),
      app_card_chain_valid: appCardChainValid,
      revocation: overrides.revocation,
      was_valid_at_signing_time: overrides.was_valid_at_signing_time,
      is_currently_valid: overrides.is_currently_valid,
      log_updates: overrides.log_updates,
      policy_compliant: overrides.policy_compliant,
      policy_match: evaluatePolicyMatch(overrides.chain, this.config.conditions),
      press_subsequently_revoked: false,
      non_compliance_reported: false,
      addressed_to_verifier: false,
      errors,
      annotations: [],
      ...(this.config.returnChain ? { chain: overrides.chain } : {}),
    };
  }

  #aggregateEnvelopePolicyMatch(signatures: SignatureVerificationResult[]): PolicyMatchResult | null {
    if (!this.config.conditions) return null;
    if (signatures.some((s) => s.policy_match?.matched === true)) return { matched: true };
    const anyFieldMismatch = signatures.some((s) => s.policy_match?.reason === "field_mismatch");
    return { matched: false, reason: anyFieldMismatch ? "field_mismatch" : "no_policy_match" };
  }

  #skippedResult(
    cardAddress: string,
    errors: VerificationError[]
  ): CardVerificationResult {
    return {
      signer_card: cardAddress,
      signature_valid: null,
      protocol_version: PROTOCOL_VERSION_0_1,
      scope_clean: "skipped",
      chain_reaches_trusted_root: "skipped",
      chain_card_addresses: [],
      app_card_chain_valid: "skipped",
      revocation: { status: "unknown", code: null, effective_date: null, data_freshness_seconds: 0 },
      was_valid_at_signing_time: "skipped",
      is_currently_valid: "skipped",
      log_updates: [],
      policy_compliant: "skipped",
      policy_match: evaluatePolicyMatch([], this.config.conditions),
      press_subsequently_revoked: false,
      non_compliance_reported: false,
      addressed_to_verifier: false,
      errors,
      annotations: [],
      ...(this.config.returnChain ? { chain: [] } : {}),
    };
  }
}
