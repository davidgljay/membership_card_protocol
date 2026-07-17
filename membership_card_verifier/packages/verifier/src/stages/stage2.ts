import { keccak256, hkdfSha3256, aes256gcmDecrypt, mlDsa44Verify } from "../crypto.js";
import { CardProtocolError } from "../errors.js";
import { canonicalize } from "../canonicalize.js";
import type {
  RpcProvider,
  IpfsProvider,
  CardDocument,
  SubCardDocument,
  VerificationError,
  VerifierConfig,
} from "../types.js";

export interface Stage2Result {
  scope_clean: boolean | "skipped";
  signer_card: string;
  master_card_doc?: CardDocument;
  master_card_pubkey?: Uint8Array;
  app_card_chain_valid: boolean | "skipped";
  errors: VerificationError[];
}

export async function verifyStage2(
  publicKeyBytes: Uint8Array,
  rpc: RpcProvider,
  ipfs: IpfsProvider,
  config: Pick<VerifierConfig, "appCertificationRoot" | "maxChainDepth">
): Promise<Stage2Result> {
  const errors: VerificationError[] = [];
  const signerCard = keccak256(publicKeyBytes);

  // Step 2: fetch card entry
  const cardEntry = await rpc.getCardEntry(signerCard);
  if (!cardEntry || !cardEntry.exists) {
    errors.push({ stage: 2, code: "CARD_NOT_FOUND", message: `No card entry for ${signerCard}` });
    return { scope_clean: false, signer_card: signerCard, app_card_chain_valid: false, errors };
  }

  // Step 3: derive leaf content key
  const leafContentKey = hkdfSha3256(publicKeyBytes, "card-content-v1");

  // Step 4: fetch and decrypt sub-card document from IPFS
  let subCardDoc: SubCardDocument;
  try {
    const encrypted = await ipfs.fetch(cardEntry.log_head_cid);
    const decrypted = aes256gcmDecrypt(leafContentKey, encrypted);
    subCardDoc = JSON.parse(new TextDecoder().decode(decrypted)) as SubCardDocument;
  } catch (e) {
    const code = e instanceof CardProtocolError ? e.code : "DECRYPTION_FAILED";
    errors.push({ stage: 2, code, message: String(e) });
    return { scope_clean: false, signer_card: signerCard, app_card_chain_valid: false, errors };
  }

  // Step 5 & 6: binding checks on holder_primary_card and app_card
  const holderPubkeyBytes = Buffer.from(subCardDoc.holder_primary_card_pubkey, "base64url");
  const holderCardAddress = keccak256(new Uint8Array(holderPubkeyBytes));
  if (holderCardAddress !== subCardDoc.holder_primary_card) {
    errors.push({
      stage: 2,
      code: "ADDRESS_BINDING_MISMATCH",
      message: "keccak256(holder_primary_card_pubkey) does not match holder_primary_card pointer",
    });
    return { scope_clean: false, signer_card: signerCard, app_card_chain_valid: false, errors };
  }

  const appPubkeyBytes = Buffer.from(subCardDoc.app_card_pubkey, "base64url");
  const appCardAddress = keccak256(new Uint8Array(appPubkeyBytes));
  if (appCardAddress !== subCardDoc.app_card) {
    errors.push({
      stage: 2,
      code: "ADDRESS_BINDING_MISMATCH",
      message: "keccak256(app_card_pubkey) does not match app_card pointer",
    });
    return { scope_clean: false, signer_card: signerCard, app_card_chain_valid: false, errors };
  }

  // Step 7: derive master card content key
  const masterContentKey = hkdfSha3256(new Uint8Array(holderPubkeyBytes), "card-content-v1");

  // Step 8: fetch and decrypt master card document
  const masterCardEntry = await rpc.getCardEntry(holderCardAddress);
  if (!masterCardEntry || !masterCardEntry.exists) {
    errors.push({ stage: 2, code: "CARD_NOT_FOUND", message: `Master card not found: ${holderCardAddress}` });
    return { scope_clean: false, signer_card: signerCard, app_card_chain_valid: false, errors };
  }

  let masterCardDoc: CardDocument;
  try {
    const encrypted = await ipfs.fetch(masterCardEntry.log_head_cid);
    const decrypted = aes256gcmDecrypt(masterContentKey, encrypted);
    masterCardDoc = JSON.parse(new TextDecoder().decode(decrypted)) as CardDocument;
  } catch (e) {
    const code = e instanceof CardProtocolError ? e.code : "DECRYPTION_FAILED";
    errors.push({ stage: 2, code, message: String(e) });
    return { scope_clean: false, signer_card: signerCard, app_card_chain_valid: false, errors };
  }

  // Step 9: confirm sub-card appears in master's active_subcards field (IPFS directory)
  // Derive keccak256(entry_pubkey) for each entry in active_subcards and check for match
  const activeSubcardsArray = (masterCardDoc.active_subcards as string[] | undefined) ?? [];
  let foundInActiveSubcards = false;
  for (const subcardPubkeyB64 of activeSubcardsArray) {
    try {
      const subcardPubkeyBytes = new Uint8Array(Buffer.from(subcardPubkeyB64, "base64url"));
      const subcardAddress = keccak256(subcardPubkeyBytes);
      if (subcardAddress === signerCard) {
        foundInActiveSubcards = true;
        break;
      }
    } catch (e) {
      // Ignore decode errors and continue checking other entries
      continue;
    }
  }
  if (!foundInActiveSubcards) {
    errors.push({
      stage: 2,
      code: "SUB_CARD_NOT_IN_ACTIVE_DIRECTORY",
      message: `Sub-card ${signerCard} not found in master card's active_subcards directory`,
    });
    return { scope_clean: false, signer_card: signerCard, app_card_chain_valid: false, errors };
  }

  // Step 10: confirm sub-card appears in master's registrations (via on-chain SubCardEntry)
  const subCardEntry = await rpc.getSubCardEntry(signerCard);
  if (!subCardEntry || subCardEntry.master_card_address !== holderCardAddress) {
    errors.push({
      stage: 2,
      code: "ADDRESS_BINDING_MISMATCH",
      message: "Sub-card on-chain entry does not link to expected master card",
    });
    return { scope_clean: false, signer_card: signerCard, app_card_chain_valid: false, errors };
  }

  // Step 11: verify master card holder's ML-DSA-44 signature on sub-card registration
  const { holder_signature, ...subCardDocWithoutHolderSig } = subCardDoc;
  const holderSigBytes = Buffer.from(holder_signature, "base64url");
  const subCardCanonical = canonicalize(subCardDocWithoutHolderSig);
  const holderSigValid = mlDsa44Verify(
    new Uint8Array(holderPubkeyBytes),
    subCardCanonical,
    new Uint8Array(holderSigBytes)
  );
  if (!holderSigValid) {
    errors.push({ stage: 2, code: "INVALID_HOLDER_SIGNATURE", message: "Holder signature on sub-card document is invalid" });
    return { scope_clean: false, signer_card: signerCard, app_card_chain_valid: false, errors };
  }

  // Step 12: check on-chain active status
  if (!subCardEntry.active) {
    errors.push({ stage: 2, code: "SUB_CARD_INACTIVE", message: "Sub-card is not active on-chain" });
    return { scope_clean: false, signer_card: signerCard, app_card_chain_valid: false, errors };
  }

  // Step 13: verify app_signature using app_card_pubkey
  const { app_signature, holder_signature: _hs, ...subCardDocWithoutSigs } = subCardDoc;
  const appSigBytes = Buffer.from(app_signature, "base64url");
  const appSigCanonical = canonicalize(subCardDocWithoutSigs);
  const appSigValid = mlDsa44Verify(
    new Uint8Array(appPubkeyBytes),
    appSigCanonical,
    new Uint8Array(appSigBytes)
  );
  if (!appSigValid) {
    errors.push({ stage: 2, code: "INVALID_APP_SIGNATURE", message: "App signature on sub-card document is invalid" });
    return { scope_clean: false, signer_card: signerCard, app_card_chain_valid: false, errors };
  }

  // Step 14: [Planned] sub-card limitations enforcement
  // TODO: Check that the message payload conforms to all limitations in subCardDoc.limitations
  // (This requires passing the message payload through the verification pipeline)
  // See: protocol-objects.md §16, messaging_protocol.md §9-11, subcards.md §Limitations

  // Step 15: app_card chain walk — confirm app_card chains to appCertificationRoot
  // (APP_CARD_CHAIN_NOT_TRUSTED if the chain does not reach the configured root)
  //
  // We've now confirmed this signer IS a sub-card (valid bindings, valid holder and
  // app signatures, active on-chain registration) — this is the point at which the
  // chain walk would otherwise run. If this verifier instance was never configured
  // with an appCertificationRoot, that is a hard, loud failure rather than a silent
  // skip: a verifier scoped to primary-card-only use can omit this config, but any
  // sub-card signature it actually encounters must be rejected, not waved through.
  if (!config.appCertificationRoot) {
    errors.push({
      stage: 2,
      code: "APP_CERTIFICATION_ROOT_NOT_CONFIGURED",
      message:
        "Sub-card signature encountered but VerifierConfig.appCertificationRoot is not configured on this verifier instance",
    });
    return { scope_clean: false, signer_card: signerCard, app_card_chain_valid: false, errors };
  }

  const appCertRoot = config.appCertificationRoot;
  const maxDepth = config.maxChainDepth ?? 64;

  const appCardContentKey = hkdfSha3256(new Uint8Array(appPubkeyBytes), "card-content-v1");
  const appCardEntry = await rpc.getCardEntry(appCardAddress);
  if (!appCardEntry || !appCardEntry.exists) {
    errors.push({
      stage: 2,
      code: "APP_CARD_CHAIN_NOT_TRUSTED",
      message: `app_card ${appCardAddress} not found on-chain`,
    });
    return { scope_clean: false, signer_card: signerCard, app_card_chain_valid: false, errors };
  }

  let appCardDoc: CardDocument;
  try {
    const encrypted = await ipfs.fetch(appCardEntry.log_head_cid);
    const decrypted = aes256gcmDecrypt(appCardContentKey, encrypted);
    appCardDoc = JSON.parse(new TextDecoder().decode(decrypted)) as CardDocument;
  } catch (e) {
    const code = e instanceof CardProtocolError ? e.code : "DECRYPTION_FAILED";
    errors.push({ stage: 2, code, message: String(e) });
    return { scope_clean: false, signer_card: signerCard, app_card_chain_valid: false, errors };
  }

  let currentDoc = appCardDoc;
  let currentAddress = appCardAddress;
  let chainReached = currentAddress === appCertRoot;

  for (let depth = 0; depth < maxDepth && !chainReached; depth++) {
    if (currentDoc.ancestry_pubkeys.length === 0) {
      chainReached = currentAddress === appCertRoot;
      break;
    }
    const nextPubkeyB64 = currentDoc.ancestry_pubkeys[0];
    if (!nextPubkeyB64) break;
    const nextPubkeyBytes = new Uint8Array(Buffer.from(nextPubkeyB64, "base64url"));
    const nextAddress = keccak256(nextPubkeyBytes);

    if (nextAddress === appCertRoot) {
      chainReached = true;
      break;
    }

    const nextEntry = await rpc.getCardEntry(nextAddress);
    if (!nextEntry || !nextEntry.exists) {
      errors.push({
        stage: 2,
        code: "APP_CARD_CHAIN_NOT_TRUSTED",
        message: `Ancestor app card not found on-chain: ${nextAddress}`,
      });
      return { scope_clean: false, signer_card: signerCard, app_card_chain_valid: false, errors };
    }

    const nextContentKey = hkdfSha3256(nextPubkeyBytes, "card-content-v1");
    try {
      const encrypted = await ipfs.fetch(nextEntry.log_head_cid);
      const decrypted = aes256gcmDecrypt(nextContentKey, encrypted);
      currentDoc = JSON.parse(new TextDecoder().decode(decrypted)) as CardDocument;
      currentAddress = nextAddress;
    } catch (e) {
      const code = e instanceof CardProtocolError ? e.code : "DECRYPTION_FAILED";
      errors.push({ stage: 2, code, message: String(e) });
      return { scope_clean: false, signer_card: signerCard, app_card_chain_valid: false, errors };
    }
  }

  if (!chainReached) {
    errors.push({
      stage: 2,
      code: "APP_CARD_CHAIN_NOT_TRUSTED",
      message: `app_card chain for ${appCardAddress} does not reach appCertificationRoot (${appCertRoot})`,
    });
    return { scope_clean: false, signer_card: signerCard, app_card_chain_valid: false, errors };
  }

  return {
    scope_clean: true,
    signer_card: signerCard,
    master_card_doc: masterCardDoc,
    master_card_pubkey: new Uint8Array(holderPubkeyBytes),
    app_card_chain_valid: true,
    errors,
  };
}
