import { keccak256, hkdfSha3256, aes256gcmDecrypt, mlDsa44Verify } from "../crypto.js";
import { CardProtocolError } from "../errors.js";
import { canonicalize } from "../canonicalize.js";
import type {
  RpcProvider,
  IpfsProvider,
  CardDocument,
  SubCardDocument,
  VerificationError,
} from "../types.js";

export interface Stage2Result {
  scope_clean: boolean | "skipped";
  signer_card: string;
  master_card_doc?: CardDocument;
  master_card_pubkey?: Uint8Array;
  errors: VerificationError[];
}

export async function verifyStage2(
  publicKeyBytes: Uint8Array,
  rpc: RpcProvider,
  ipfs: IpfsProvider
): Promise<Stage2Result> {
  const errors: VerificationError[] = [];
  const signerCard = keccak256(publicKeyBytes);

  // Step 2: fetch card entry
  const cardEntry = await rpc.getCardEntry(signerCard);
  if (!cardEntry || !cardEntry.exists) {
    errors.push({ stage: 2, code: "CARD_NOT_FOUND", message: `No card entry for ${signerCard}` });
    return { scope_clean: false, signer_card: signerCard, errors };
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
    return { scope_clean: false, signer_card: signerCard, errors };
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
    return { scope_clean: false, signer_card: signerCard, errors };
  }

  const appPubkeyBytes = Buffer.from(subCardDoc.app_card_pubkey, "base64url");
  const appCardAddress = keccak256(new Uint8Array(appPubkeyBytes));
  if (appCardAddress !== subCardDoc.app_card) {
    errors.push({
      stage: 2,
      code: "ADDRESS_BINDING_MISMATCH",
      message: "keccak256(app_card_pubkey) does not match app_card pointer",
    });
    return { scope_clean: false, signer_card: signerCard, errors };
  }

  // Step 7: derive master card content key
  const masterContentKey = hkdfSha3256(new Uint8Array(holderPubkeyBytes), "card-content-v1");

  // Step 8: fetch and decrypt master card document
  const masterCardEntry = await rpc.getCardEntry(holderCardAddress);
  if (!masterCardEntry || !masterCardEntry.exists) {
    errors.push({ stage: 2, code: "CARD_NOT_FOUND", message: `Master card not found: ${holderCardAddress}` });
    return { scope_clean: false, signer_card: signerCard, errors };
  }

  let masterCardDoc: CardDocument;
  try {
    const encrypted = await ipfs.fetch(masterCardEntry.log_head_cid);
    const decrypted = aes256gcmDecrypt(masterContentKey, encrypted);
    masterCardDoc = JSON.parse(new TextDecoder().decode(decrypted)) as CardDocument;
  } catch (e) {
    const code = e instanceof CardProtocolError ? e.code : "DECRYPTION_FAILED";
    errors.push({ stage: 2, code, message: String(e) });
    return { scope_clean: false, signer_card: signerCard, errors };
  }

  // Step 9: confirm sub-card appears in master's registrations (via on-chain SubCardEntry)
  const subCardEntry = await rpc.getSubCardEntry(signerCard);
  if (!subCardEntry || subCardEntry.master_card_address !== holderCardAddress) {
    errors.push({
      stage: 2,
      code: "ADDRESS_BINDING_MISMATCH",
      message: "Sub-card on-chain entry does not link to expected master card",
    });
    return { scope_clean: false, signer_card: signerCard, errors };
  }

  // Step 10: verify master card holder's ML-DSA-44 signature on sub-card registration
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
    return { scope_clean: false, signer_card: signerCard, errors };
  }

  // Step 11: check on-chain active status
  if (!subCardEntry.active) {
    errors.push({ stage: 2, code: "SUB_CARD_INACTIVE", message: "Sub-card is not active on-chain" });
    return { scope_clean: false, signer_card: signerCard, errors };
  }

  // Step 12: verify app_signature using app_card_pubkey
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
  }

  return {
    scope_clean: true,
    signer_card: signerCard,
    master_card_doc: masterCardDoc,
    master_card_pubkey: new Uint8Array(holderPubkeyBytes),
    errors,
  };
}
