import { KNOWN_PROTOCOL_VERSIONS } from "./constants.js";
import type { ProtocolVersion } from "./constants.js";
import { CardProtocolError } from "./errors.js";

/**
 * Extract and validate the protocol_version field from a card document
 * or message payload.
 *
 * Throws MISSING_PROTOCOL_VERSION if the field is missing or not a string.
 * Throws UNKNOWN_PROTOCOL_VERSION if the version is not in KNOWN_PROTOCOL_VERSIONS.
 */
export function extractProtocolVersion(doc: { protocol_version?: unknown }): ProtocolVersion {
  const v = doc.protocol_version;
  if (typeof v !== "string") {
    throw new CardProtocolError(
      "MISSING_PROTOCOL_VERSION",
      `protocol_version field is missing or not a string`
    );
  }
  if (!(KNOWN_PROTOCOL_VERSIONS as readonly string[]).includes(v)) {
    throw new CardProtocolError(
      "UNKNOWN_PROTOCOL_VERSION",
      `Unrecognized protocol version: "${v}". Known versions: ${KNOWN_PROTOCOL_VERSIONS.join(", ")}`
    );
  }
  return v as ProtocolVersion;
}
