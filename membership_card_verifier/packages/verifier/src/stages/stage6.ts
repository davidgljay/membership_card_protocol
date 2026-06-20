import { RECOMMENDED_ANNOTATORS_ENDPOINT } from "../constants.js";
import { verifyStage3 } from "./stage3.js";
import type {
  RpcProvider,
  IpfsProvider,
  EasAnnotation,
  VerificationError,
  VerifierConfig,
  CardDocument,
} from "../types.js";

export interface Stage6Result {
  annotations: EasAnnotation[];
  errors: VerificationError[];
}

export async function verifyStage6(
  chainCardAddresses: string[],
  rpc: RpcProvider,
  ipfs: IpfsProvider,
  config: Pick<
    VerifierConfig,
    "fetchAnnotations" | "additionalAnnotators" | "trustedRoots" | "maxChainDepth"
  >
): Promise<Stage6Result> {
  if (!config.fetchAnnotations) {
    return { annotations: [], errors: [] };
  }

  const errors: VerificationError[] = [];

  // Step 1: fetch recommended annotators list
  let recommendedAnnotators: string[] = [];
  try {
    const res = await fetch(RECOMMENDED_ANNOTATORS_ENDPOINT);
    if (res.ok) {
      recommendedAnnotators = (await res.json()) as string[];
    } else {
      errors.push({
        stage: 6,
        code: "RECOMMENDED_ANNOTATORS_FETCH_FAILED",
        message: `Annotators endpoint returned HTTP ${res.status}`,
      });
    }
  } catch (e) {
    errors.push({
      stage: 6,
      code: "RECOMMENDED_ANNOTATORS_FETCH_FAILED",
      message: `Failed to fetch recommended annotators: ${String(e)}`,
    });
  }

  // Step 2: merge with additionalAnnotators
  const additionalAnnotators = config.additionalAnnotators ?? [];
  const activeAnnotatorSet = [
    ...new Set([...recommendedAnnotators, ...additionalAnnotators]),
  ];

  if (activeAnnotatorSet.length === 0) {
    return { annotations: [], errors };
  }

  // Step 3: fetch EAS attestations for all cards in chain
  const allAttestations = await Promise.all(
    chainCardAddresses.map((addr) =>
      rpc.getEasAnnotations(addr, activeAnnotatorSet)
    )
  );
  const attestations = allAttestations.flat();

  // Step 4: process each attestation
  const annotations: EasAnnotation[] = [];
  for (const attest of attestations) {
    // Fetch and decode annotation content document from IPFS
    // TODO: clarify whether annotation documents are encrypted once spec is finalized.
    // Currently treating them as plaintext public IPFS content.
    let content: Record<string, unknown>;
    try {
      const bytes = await ipfs.fetch(attest.cid);
      content = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    } catch (e) {
      errors.push({
        stage: 6,
        code: "ANNOTATION_FETCH_FAILED",
        message: `Failed to fetch annotation ${attest.uid}: ${String(e)}`,
      });
      continue;
    }

    // Walk annotator's chain to check if it reaches a trusted root
    // Derive annotator's card address and fetch their card doc for chain walk
    let annotatorChainTrusted = false;
    try {
      const annotatorEntry = await rpc.getCardEntry(attest.attester);
      if (annotatorEntry?.exists) {
        // Minimal chain walk: just check if the annotator card's address is itself trusted
        annotatorChainTrusted =
          (config.trustedRoots ?? []).includes(attest.attester) ||
          (await rpc.isPolicyAuthorizer(attest.attester));

        if (!annotatorChainTrusted && annotatorEntry.log_head_cid) {
          // Attempt to walk the annotator's chain using stage3 logic.
          // We need the annotator's card doc, but we don't have the pubkey to decrypt it here.
          // The annotator's address is derived from their pubkey via keccak256, but we don't
          // have the pubkey stored anywhere without decrypting their card.
          // For now, mark as not trusted unless directly in trusted roots or PolicyAuthorizerKeys.
          // TODO: full chain walk requires annotator pubkey — needs spec clarification.
          annotatorChainTrusted = false;
        }
      }
    } catch (e) {
      errors.push({
        stage: 6,
        code: "ANNOTATOR_CHAIN_WALK_FAILED",
        message: `Failed to walk annotator chain for ${attest.attester}: ${String(e)}`,
      });
    }

    annotations.push({
      eas_uid: attest.uid,
      annotator_card: attest.attester,
      annotator_chain_trusted: annotatorChainTrusted,
      is_recommended_annotator: recommendedAnnotators.includes(attest.attester),
      update_code: attest.update_code,
      cid: attest.cid,
      content,
      effective_date: attest.effective_date,
    });
  }

  return { annotations, errors };
}
