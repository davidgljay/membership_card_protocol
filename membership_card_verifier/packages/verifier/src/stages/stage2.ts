import { decryptCardHead } from "../head.js";
import { keccak256, hkdfSha3256, aes256gcmDecrypt, mlDsa44Verify, base64UrlToBytes } from "../crypto.js";
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
  /** Set once the app card chain walk completes (step 16f). */
  app_card_branch?: "login_service" | "other";
  /** The decrypted SubCardDocument, when the signer is a sub-card. */
  sub_card_doc?: SubCardDocument;
  errors: VerificationError[];
}

export async function verifyStage2(
  publicKeyBytes: Uint8Array,
  rpc: RpcProvider,
  ipfs: IpfsProvider,
  config: Pick<VerifierConfig, "appCertificationRoot" | "loginServiceCertificationRoot" | "maxChainDepth">
): Promise<Stage2Result> {
  const errors: VerificationError[] = [];
  const signerCard = keccak256(publicKeyBytes);

  // Step 2: locate the sub-card document. The registry contract's
  // RegisterSubCard records a SubCardEntry (sub_card_doc_cid) rather than a
  // CardEntry, and the press pins the document as plain canonical JSON; a
  // CardEntry whose head is the encrypted document is also accepted.
  const cardEntry = await rpc.getCardEntry(signerCard);
  let docCid: string | undefined = cardEntry?.exists ? cardEntry.log_head_cid : undefined;
  if (!docCid) {
    const sub = await rpc.getSubCardEntry(signerCard);
    docCid = sub?.sub_card_doc_cid || undefined;
  }
  if (!docCid) {
    errors.push({ stage: 2, code: "CARD_NOT_FOUND", message: `No card or sub-card entry for ${signerCard}` });
    return { scope_clean: false, signer_card: signerCard, app_card_chain_valid: false, errors };
  }

  // Step 3: derive leaf content key
  const leafContentKey = hkdfSha3256(publicKeyBytes, "card-content-v1");

  // Step 4: fetch the sub-card document (encrypted under the leaf key, or plain)
  let subCardDoc: SubCardDocument;
  try {
    const raw = await ipfs.fetch(docCid);
    let text: string;
    try {
      text = new TextDecoder().decode(await aes256gcmDecrypt(leafContentKey, raw));
    } catch {
      text = new TextDecoder().decode(raw);
    }
    subCardDoc = JSON.parse(text) as SubCardDocument;
  } catch (e) {
    const code = e instanceof CardProtocolError ? e.code : "DECRYPTION_FAILED";
    errors.push({ stage: 2, code, message: String(e) });
    return { scope_clean: false, signer_card: signerCard, app_card_chain_valid: false, errors };
  }
  // The document must be this signer's: its recipient_pubkey is the signing key.
  if (typeof subCardDoc.recipient_pubkey !== "string" || keccak256(new Uint8Array(base64UrlToBytes(subCardDoc.recipient_pubkey))) !== signerCard) {
    errors.push({ stage: 2, code: "ADDRESS_BINDING_MISMATCH", message: "sub-card document recipient_pubkey is not the signing key" });
    return { scope_clean: false, signer_card: signerCard, app_card_chain_valid: false, errors };
  }

  // Step 5 & 6: binding checks on holder_primary_card and app_card
  const holderPubkeyBytes = base64UrlToBytes(subCardDoc.holder_primary_card_pubkey);
  const holderCardAddress = keccak256(new Uint8Array(holderPubkeyBytes));
  if (holderCardAddress !== subCardDoc.holder_primary_card) {
    errors.push({
      stage: 2,
      code: "ADDRESS_BINDING_MISMATCH",
      message: "keccak256(holder_primary_card_pubkey) does not match holder_primary_card pointer",
    });
    return { scope_clean: false, signer_card: signerCard, app_card_chain_valid: false, errors };
  }

  const appPubkeyBytes = base64UrlToBytes(subCardDoc.app_card_pubkey);
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
    masterCardDoc = await decryptCardHead(masterCardEntry.log_head_cid, masterContentKey, ipfs);
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
      const subcardPubkeyBytes = new Uint8Array(base64UrlToBytes(subcardPubkeyB64));
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
  const holderSigBytes = base64UrlToBytes(holder_signature);
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
  const appSigBytes = base64UrlToBytes(app_signature);
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
    appCardDoc = await decryptCardHead(appCardEntry.log_head_cid, appCardContentKey, ipfs);
  } catch (e) {
    const code = e instanceof CardProtocolError ? e.code : "DECRYPTION_FAILED";
    errors.push({ stage: 2, code, message: String(e) });
    return { scope_clean: false, signer_card: signerCard, app_card_chain_valid: false, errors };
  }

  let currentDoc = appCardDoc;
  let currentAddress = appCardAddress;
  // Every address on the app card's chain below the root, for step 16f.
  const visited: string[] = [appCardAddress];
  let chainReached = currentAddress === appCertRoot;

  for (let depth = 0; depth < maxDepth && !chainReached; depth++) {
    if (currentDoc.ancestry_pubkeys.length === 0) {
      chainReached = currentAddress === appCertRoot;
      break;
    }
    const nextPubkeyB64 = currentDoc.ancestry_pubkeys[0];
    if (!nextPubkeyB64) break;
    const nextPubkeyBytes = new Uint8Array(base64UrlToBytes(nextPubkeyB64));
    const nextAddress = keccak256(nextPubkeyBytes);

    if (nextAddress === appCertRoot) {
      chainReached = true;
      break;
    }
    visited.push(nextAddress);

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
      currentDoc = await decryptCardHead(nextEntry.log_head_cid, nextContentKey, ipfs);
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

  // Step 16f (card_verifier.md §7.2): branch and login service scope rule.
  // Recognizing the login service branch is mandatory once sub-cards are being
  // verified: without it, a login service card could pose as an app or wallet card.
  if (!config.loginServiceCertificationRoot) {
    errors.push({
      stage: 2,
      code: "LOGIN_SERVICE_CERTIFICATION_ROOT_NOT_CONFIGURED",
      message:
        "Sub-card signature encountered but VerifierConfig.loginServiceCertificationRoot is not configured on this verifier instance",
    });
    return { scope_clean: false, signer_card: signerCard, app_card_chain_valid: true, errors };
  }
  const isLoginService = visited.includes(config.loginServiceCertificationRoot);
  const appCardBranch = isLoginService ? "login_service" : "other";
  const selfScoped = appCardAddress === holderCardAddress;
  if (isLoginService && !selfScoped) {
    errors.push({
      stage: 2,
      code: "LOGIN_SERVICE_SCOPE",
      message: `app_card ${appCardAddress} is a login service card but the sub-card's master is ${holderCardAddress}; a login service card may only authorize its own server cards`,
    });
    return { scope_clean: false, signer_card: signerCard, app_card_chain_valid: true, app_card_branch: appCardBranch, errors };
  }
  if (subCardDoc.attestation_level === "S1" && !(isLoginService && selfScoped)) {
    errors.push({
      stage: 2,
      code: "ATTESTATION_LEVEL_INSUFFICIENT",
      message: 'attestation_level "S1" is accepted only on server cards (login service card as both app_card and holder)',
    });
    return { scope_clean: false, signer_card: signerCard, app_card_chain_valid: true, app_card_branch: appCardBranch, errors };
  }

  return {
    scope_clean: true,
    signer_card: signerCard,
    master_card_doc: masterCardDoc,
    master_card_pubkey: new Uint8Array(holderPubkeyBytes),
    app_card_chain_valid: true,
    app_card_branch: appCardBranch,
    sub_card_doc: subCardDoc,
    errors,
  };
}
