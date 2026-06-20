import { createHash } from "node:crypto";
import { canonicalize } from "./canonicalize.js";
import { keccak256 } from "./crypto.js";
import { CardProtocolError } from "./errors.js";
import { verifyStage1 } from "./stages/stage1.js";
import { verifyStage2 } from "./stages/stage2.js";
import { verifyStage3 } from "./stages/stage3.js";
import { verifyStage4 } from "./stages/stage4.js";
import { verifyStage5 } from "./stages/stage5.js";
import { verifyStage6 } from "./stages/stage6.js";
import type {
  VerifierConfig,
  SignedMessageEnvelope,
  EnvelopeVerificationResult,
  SignatureVerificationResult,
  CardVerificationResult,
  VerifyCardOptions,
  VerificationError,
} from "./types.js";

const DEFAULTS = {
  trustedRoots: [] as string[],
  revocationFreshnessWindowSeconds: 300,
  rejectStaleRevocation: true,
  maxChainDepth: 64,
  fetchAnnotations: false,
  additionalAnnotators: [] as string[],
} as const;

export class CardVerifier {
  private readonly config: Required<Omit<VerifierConfig, "registryEndpoint">> & {
    registryEndpoint: string | undefined;
  };

  constructor(config: VerifierConfig) {
    if (!config.rpc) {
      throw new CardProtocolError("MISSING_RPC_PROVIDER", "VerifierConfig.rpc is required");
    }
    if (!config.ipfs) {
      throw new CardProtocolError("MISSING_IPFS_PROVIDER", "VerifierConfig.ipfs is required");
    }
    this.config = {
      rpc: config.rpc,
      ipfs: config.ipfs,
      trustedRoots: config.trustedRoots ?? DEFAULTS.trustedRoots,
      revocationFreshnessWindowSeconds:
        config.revocationFreshnessWindowSeconds ?? DEFAULTS.revocationFreshnessWindowSeconds,
      rejectStaleRevocation: config.rejectStaleRevocation ?? DEFAULTS.rejectStaleRevocation,
      maxChainDepth: config.maxChainDepth ?? DEFAULTS.maxChainDepth,
      registryEndpoint: config.registryEndpoint,
      fetchAnnotations: config.fetchAnnotations ?? DEFAULTS.fetchAnnotations,
      additionalAnnotators: config.additionalAnnotators ?? DEFAULTS.additionalAnnotators,
    };
  }

  async verifyEnvelope(
    envelope: SignedMessageEnvelope
  ): Promise<EnvelopeVerificationResult> {
    const canonicalEnvelope = canonicalize(envelope);
    const envelope_id = createHash("sha256").update(canonicalEnvelope).digest("hex");
    const verified_at = new Date().toISOString();

    const signatures = await Promise.all(
      envelope.signatures.map((entry) =>
        this.#verifySignatureEntry(entry, envelope.payload, envelope.payload.timestamp)
      )
    );

    return { envelope_id, verified_at, signatures };
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

    // Stage 4: revocation check
    const stage4 = await verifyStage4(
      chainAddresses,
      signingTimestamp,
      this.config.rpc,
      this.config
    );

    // Stage 6: annotations
    const stage6 = await verifyStage6(chainAddresses, this.config.rpc, this.config.ipfs, this.config);

    const allErrors = [...errors, ...stage4.errors, ...stage6.errors];

    return {
      signer_card: cardAddress,
      signature_valid: null,
      scope_clean: "skipped",
      chain_reaches_trusted_root: isTrustedRoot,
      revocation: stage4.revocation,
      was_valid_at_signing_time: stage4.was_valid_at_signing_time,
      is_currently_valid: stage4.is_currently_valid,
      log_updates: stage4.log_updates,
      policy_compliant: "skipped",
      policy_match: null,
      press_subsequently_revoked: false,
      non_compliance_reported: false,
      addressed_to_verifier: false,
      errors: allErrors,
      annotations: stage6.annotations,
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
    const stage2 = await verifyStage2(publicKeyBytes, this.config.rpc, this.config.ipfs);
    errors.push(...stage2.errors);

    if (stage2.scope_clean === false && !stage2.master_card_doc) {
      // Hard rejection: skip stages 3–5
      return this.#buildResult(signerCard, signatureValid, stage2.scope_clean, "skipped", errors, {
        revocation: { status: "unknown", code: null, effective_date: null, data_freshness_seconds: 0 },
        was_valid_at_signing_time: "skipped",
        is_currently_valid: "skipped",
        log_updates: [],
        policy_compliant: "skipped",
      });
    }

    // Stage 3
    const startDoc = stage2.master_card_doc!;
    const startAddress = stage2.signer_card;
    const stage3 = await verifyStage3(
      startDoc,
      startAddress,
      this.config.rpc,
      this.config.ipfs,
      this.config
    );
    errors.push(...stage3.errors);

    if (stage3.chain_reaches_trusted_root === false && stage3.errors.some((e) => e.code === "DECRYPTION_FAILED" || e.code === "ADDRESS_BINDING_MISMATCH")) {
      // Hard rejection mid-chain: skip stages 4–5
      return this.#buildResult(signerCard, signatureValid, stage2.scope_clean, stage3.chain_reaches_trusted_root, errors, {
        revocation: { status: "unknown", code: null, effective_date: null, data_freshness_seconds: 0 },
        was_valid_at_signing_time: "skipped",
        is_currently_valid: "skipped",
        log_updates: [],
        policy_compliant: "skipped",
      });
    }

    // Stage 4
    const stage4 = await verifyStage4(
      stage3.chain_card_addresses,
      signingTimestamp,
      this.config.rpc,
      this.config
    );
    errors.push(...stage4.errors);

    // Stage 5
    const cardEntry = await this.config.rpc.getCardEntry(signerCard);
    let policyCompliant: boolean | null | "skipped" = "skipped";
    let policyMatch: boolean | null = null;
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
      policyMatch = stage5.policy_match;
      pressSubsequentlyRevoked = stage5.press_subsequently_revoked;
      nonComplianceReported = stage5.non_compliance_reported;
    }

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
    };
  }

  #buildResult(
    signerCard: string,
    signatureValid: boolean,
    scopeClean: boolean | "skipped",
    chainReachesTrustedRoot: boolean | "skipped",
    errors: VerificationError[],
    overrides: {
      revocation: SignatureVerificationResult["revocation"];
      was_valid_at_signing_time: boolean | "skipped";
      is_currently_valid: boolean | "skipped";
      log_updates: SignatureVerificationResult["log_updates"];
      policy_compliant: boolean | null | "skipped";
    }
  ): SignatureVerificationResult {
    return {
      signer_card: signerCard,
      signature_valid: signatureValid,
      scope_clean: scopeClean,
      chain_reaches_trusted_root: chainReachesTrustedRoot,
      revocation: overrides.revocation,
      was_valid_at_signing_time: overrides.was_valid_at_signing_time,
      is_currently_valid: overrides.is_currently_valid,
      log_updates: overrides.log_updates,
      policy_compliant: overrides.policy_compliant,
      policy_match: null,
      press_subsequently_revoked: false,
      non_compliance_reported: false,
      addressed_to_verifier: false,
      errors,
      annotations: [],
    };
  }

  #skippedResult(
    cardAddress: string,
    errors: VerificationError[]
  ): CardVerificationResult {
    return {
      signer_card: cardAddress,
      signature_valid: null,
      scope_clean: "skipped",
      chain_reaches_trusted_root: "skipped",
      revocation: { status: "unknown", code: null, effective_date: null, data_freshness_seconds: 0 },
      was_valid_at_signing_time: "skipped",
      is_currently_valid: "skipped",
      log_updates: [],
      policy_compliant: "skipped",
      policy_match: null,
      press_subsequently_revoked: false,
      non_compliance_reported: false,
      addressed_to_verifier: false,
      errors,
      annotations: [],
    };
  }
}
