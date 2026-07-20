import { keccak256, hkdfSha3256, aes256gcmDecrypt } from "../crypto.js";
import { CardProtocolError } from "../errors.js";
import type {
  RpcProvider,
  IpfsProvider,
  CardDocument,
  VerificationError,
  VerifierConfig,
  ChainLink,
} from "../types.js";

export type { ChainLink };

export interface Stage3Result {
  chain_reaches_trusted_root: boolean | "skipped";
  chain_card_addresses: string[];
  chain: ChainLink[];
  errors: VerificationError[];
}

export async function verifyStage3(
  startCardDoc: CardDocument,
  startCardAddress: string,
  rpc: RpcProvider,
  ipfs: IpfsProvider,
  config: Pick<VerifierConfig, "trustedRoots" | "maxChainDepth">,
  startCardPubkey?: Uint8Array
): Promise<Stage3Result> {
  const trustedRoots = config.trustedRoots ?? [];
  const maxDepth = config.maxChainDepth ?? 64;
  const errors: VerificationError[] = [];
  const chainAddresses: string[] = [startCardAddress];
  const chain: ChainLink[] = [
    {
      card_address: startCardAddress,
      public_key: startCardPubkey ? Buffer.from(startCardPubkey).toString("base64url") : "",
      card_content: startCardDoc,
    },
  ];

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
        chain,
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
      // Note: the root's CardDocument is not fetched/decrypted here (no new I/O per
      // the plan's constraint), so it is not added to `chain` — only to
      // `chain_card_addresses`, which already tracked addresses-only.
      return {
        chain_reaches_trusted_root: true,
        chain_card_addresses: chainAddresses,
        chain,
        errors,
      };
    }

    // Walk one hop: verify the first ancestry_pubkeys entry matches the expected on-chain address
    const cardEntry = await rpc.getCardEntry(nextAddress);
    if (!cardEntry || !cardEntry.exists) {
      errors.push({ stage: 3, code: "CARD_NOT_FOUND", message: `Ancestor card not found: ${nextAddress}` });
      return { chain_reaches_trusted_root: false, chain_card_addresses: chainAddresses, chain, errors };
    }

    const contentKey = hkdfSha3256(nextPubkeyBytes, "card-content-v1");
    let ancestorDoc: CardDocument;
    try {
      const encrypted = await ipfs.fetch(cardEntry.log_head_cid);
      const decrypted = await aes256gcmDecrypt(contentKey, encrypted);
      ancestorDoc = JSON.parse(new TextDecoder().decode(decrypted)) as CardDocument;
    } catch (e) {
      const code = e instanceof CardProtocolError ? e.code : "DECRYPTION_FAILED";
      errors.push({ stage: 3, code, message: String(e) });
      return { chain_reaches_trusted_root: false, chain_card_addresses: chainAddresses, chain, errors };
    }

    chainAddresses.push(nextAddress);
    chain.push({
      card_address: nextAddress,
      public_key: nextPubkeyB64,
      card_content: ancestorDoc,
    });
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
    chain,
    errors,
  };
}
