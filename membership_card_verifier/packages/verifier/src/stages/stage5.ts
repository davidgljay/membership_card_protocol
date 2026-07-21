import { PRESS_REGISTRY_BODY_ENDPOINT } from "../constants.js";
import { bytesToBase64Url } from "../crypto.js";
import type {
  RpcProvider,
  IpfsProvider,
  CardDocument,
  CardEntry,
  NonComplianceReport,
  FailedCheck,
  VerificationError,
  VerifierConfig,
} from "../types.js";

export interface Stage5Result {
  policy_compliant: boolean | null | "skipped";
  policy_match: boolean | null;
  press_subsequently_revoked: boolean;
  non_compliance_reported: boolean;
  errors: VerificationError[];
}

interface PolicyDocument {
  field_definitions?: Record<string, { required?: boolean; type?: string; [k: string]: unknown }>;
  [key: string]: unknown;
}

export async function verifyStage5(
  cardDoc: CardDocument,
  cardEntry: CardEntry,
  cardAddress: string,
  cardCid: string,
  rawCardBytes: Uint8Array,
  rpc: RpcProvider,
  ipfs: IpfsProvider,
  config: { registryEndpoint?: string | undefined }
): Promise<Stage5Result> {
  const errors: VerificationError[] = [];
  const failedChecks: FailedCheck[] = [];

  // Step 1: fetch policy snapshot at the immutable policy_id CID
  let policyDoc: PolicyDocument;
  try {
    const policyBytes = await ipfs.fetch(cardDoc.policy_id);
    policyDoc = JSON.parse(new TextDecoder().decode(policyBytes)) as PolicyDocument;
  } catch {
    errors.push({ stage: 5, code: "POLICY_FETCH_FAILED", message: "Could not fetch policy snapshot" });
    return {
      policy_compliant: null,
      policy_match: null,
      press_subsequently_revoked: false,
      non_compliance_reported: false,
      errors,
    };
  }

  // Step 2: evaluate card field values against field_definitions
  if (policyDoc.field_definitions) {
    for (const [fieldName, def] of Object.entries(policyDoc.field_definitions)) {
      if (def["required"] && !(fieldName in cardDoc)) {
        failedChecks.push({
          check: "FIELD_POLICY_VIOLATION",
          field: fieldName,
          detail: `Required field "${fieldName}" is missing`,
        });
      }
    }
  }

  // Step 3: check press authorization on-chain
  const pressEntry = await rpc.getPressAuthorization(
    cardEntry.policy_address,
    cardEntry.last_press_address
  );

  let pressSubsequentlyRevoked = false;
  if (!pressEntry) {
    failedChecks.push({
      check: "NO_PRESS_AUTHORIZATION",
      detail: `No press authorization found for policy=${cardEntry.policy_address} press=${cardEntry.last_press_address}`,
    });
  } else if (!pressEntry.active) {
    // Press was revoked after registration — card is still valid, but flag it
    pressSubsequentlyRevoked = true;
  }

  const policyCompliant = failedChecks.length === 0;

  // Step 5: non-compliance reporting
  let nonComplianceReported = false;
  if (!policyCompliant) {
    const report: NonComplianceReport = {
      card_address: cardAddress,
      press_address: cardEntry.last_press_address,
      ipfs_card_document: bytesToBase64Url(rawCardBytes),
      ipfs_cid: cardCid,
      failed_checks: failedChecks,
      verified_at: new Date().toISOString(),
    };

    const endpoint = config.registryEndpoint ?? PRESS_REGISTRY_BODY_ENDPOINT;
    try {
      const res = await fetch(`${endpoint}/non-compliance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(report),
      });
      nonComplianceReported = res.ok;
      if (!res.ok) {
        errors.push({
          stage: 5,
          code: "NON_COMPLIANCE_REPORT_FAILED",
          message: `Registry Body returned HTTP ${res.status}`,
        });
      }
    } catch (e) {
      errors.push({
        stage: 5,
        code: "NON_COMPLIANCE_REPORT_FAILED",
        message: `Failed to POST non-compliance report: ${String(e)}`,
      });
    }
  }

  return {
    policy_compliant: policyCompliant,
    policy_match: null, // per-call predicate not supported in VerifierConfig; null = not supplied
    press_subsequently_revoked: pressSubsequentlyRevoked,
    non_compliance_reported: nonComplianceReported,
    errors,
  };
}
