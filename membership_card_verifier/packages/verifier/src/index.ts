export { CardVerifier } from "./CardVerifier.js";
export { CardProtocolError } from "./errors.js";
export { canonicalize } from "./canonicalize.js";
export { mlDsa44Verify } from "./crypto.js";
export { evaluatePolicyMatch } from "./policy-match.js";
export {
  PROTOCOL_VERSION_0_1,
  KNOWN_PROTOCOL_VERSIONS,
} from "./constants.js";
export { extractProtocolVersion } from "./version.js";
export { requestHash, signingBytes, httpsOrigin, domainCovers } from "./login/encoding.js";
export { checkDomainBindingSignature, checkDomainBinding } from "./login/domainBinding.js";
export { readCardFields, readSubCardDocument, policyOf, policyLineage, matchMcardQuery, effectivePreferredServices, normAddress } from "./login/chain.js";
export type { ChainContext, PolicyRef, DcqlMatch } from "./login/chain.js";
export type { VerifyServerCardOptions, ServerCardVerificationResult, VerifyLoginResponseInput, LoginVerificationResult, LoginWarning } from "./login/verify.js";
export type { DomainBindingResult } from "./login/domainBinding.js";
export { decryptCardHead } from "./head.js";
export type * from "./login/types.js";

export type { ProtocolVersion } from "./constants.js";

export type {
  RpcProvider,
  IpfsProvider,
  VerifierConfig,
  SignedMessageEnvelope,
  SignatureEntry,
  VerifyCardOptions,
  EnvelopeVerificationResult,
  SignatureVerificationResult,
  CardVerificationResult,
  RevocationStatus,
  LogUpdate,
  VerificationError,
  EasAnnotation,
  NonComplianceReport,
  FailedCheck,
  CardEntry,
  PressAuthEntry,
  SubCardEntry,
  CardChainEvent,
  EasAttestation,
  CardDocument,
  SubCardDocument,
  PastKey,
  ChainLink,
  PolicyMatchConditions,
  DomainRegistration,
} from "./types.js";
