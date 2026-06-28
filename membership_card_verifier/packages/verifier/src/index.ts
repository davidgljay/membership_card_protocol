export { CardVerifier } from "./CardVerifier.js";
export { CardProtocolError } from "./errors.js";
export { canonicalize } from "./canonicalize.js";
export { mlDsa44Verify } from "./crypto.js";
export {
  PROTOCOL_VERSION_0_1,
  KNOWN_PROTOCOL_VERSIONS,
} from "./constants.js";
export { extractProtocolVersion } from "./version.js";

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
  LogEntry,
  EasAttestation,
  CardDocument,
  SubCardDocument,
  PastKey,
} from "./types.js";
