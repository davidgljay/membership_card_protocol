import { keccak256, hkdfSha3256, aes256gcmDecrypt } from "../crypto.js";
import { CardProtocolError } from "../errors.js";
import type {
  RpcProvider,
  IpfsProvider,
  CardDocument,
  VerificationError,
  VerifierConfig,
} from "../types.js";

export interface Stage3Result {
  chain_reaches_trusted_root: boolean | "skipped";
  chain_card_addresses: string[];
  errors: VerificationError[];
}

export async function verifyStage3(
  startCardDoc: CardDocument,
  startCardAddress: string,
  rpc: RpcProvider,
  ipfs: IpfsProvider,
  config: Pick<VerifierConfig, "trustedRoots" | "maxChainDepth">
): Promise<Stage3Result> {
  const trustedRoots = config.trustedRoots ?? [];
  const maxDepth = config.maxChainDepth ?? 64;
  const errors: VerificationError[] = [];
  const chainAddresses: string[] = [startCardAddress];

  let currentDoc = startCardDoc;
  let currentAddress = startCardAddress;

  for (let depth = 0; depth < maxDepth; depth++) {
    const ancestryPubkeys = currentDoc.ancestry_pubkeys;

    if (ancestryPubkeys.length === 0) {
      // Root base case: current card is (or should be) a trusted root
      const isRoot =
        trustedRoots.includes(currentAddress) ||
        (await rpc.isPolicyAuthorizer(currentAddress));
      return {
        chain_reaches_trusted_root: isRoot,
        chain_card_addresses: chainAddresses,
        errors,
      };
    }

    // Check if the next address is already a trusted root before walking
    const nextPubkeyB64 = ancestryPubkeys[0];
    if (!nextPubkeyB64) break;
    const nextPubkeyBytes = new Uint8Array(Buffer.from(nextPubkeyB64, "base64url"));
    const nextAddress = keccak256(nextPubkeyBytes);

    const isNextRoot =
      trustedRoots.includes(nextAddress) ||
      (await rpc.isPolicyAuthorizer(nextAddress));

    if (isNextRoot) {
      chainAddresses.push(nextAddress);
      return {
        chain_reaches_trusted_root: true,
        chain_card_addresses: chainAddresses,
        errors,
      };
    }

    // Walk one hop: verify the first ancestry_pubkeys entry matches the expected on-chain address
    const cardEntry = await rpc.getCardEntry(nextAddress);
    if (!cardEntry || !cardEntry.exists) {
      errors.push({ stage: 3, code: "CARD_NOT_FOUND", message: `Ancestor card not found: ${nextAddress}` });
      return { chain_reaches_trusted_root: false, chain_card_addresses: chainAddresses, errors };
    }

    const contentKey = hkdfSha3256(nextPubkeyBytes, "card-content-v1");
    let ancestorDoc: CardDocument;
    try {
      const encrypted = await ipfs.fetch(cardEntry.log_head_cid);
      const decrypted = aes256gcmDecrypt(contentKey, encrypted);
      ancestorDoc = JSON.parse(new TextDecoder().decode(decrypted)) as CardDocument;
    } catch (e) {
      const code = e instanceof CardProtocolError ? e.code : "DECRYPTION_FAILED";
      errors.push({ stage: 3, code, message: String(e) });
      return { chain_reaches_trusted_root: false, chain_card_addresses: chainAddresses, errors };
    }

    chainAddresses.push(nextAddress);
    currentDoc = ancestorDoc;
    currentAddress = nextAddress;
  }

  errors.push({
    stage: 3,
    code: "CHAIN_DEPTH_EXCEEDED",
    message: `Chain walk exceeded maxChainDepth (${maxDepth})`,
  });
  return {
    chain_reaches_trusted_root: false,
    chain_card_addresses: chainAddresses,
    errors,
  };
}
