export const PRESS_REGISTRY_BODY_ENDPOINT = "PRESS_REGISTRY_BODY_ENDPOINT_PLACEHOLDER";

export const RECOMMENDED_ANNOTATORS_ENDPOINT = "RECOMMENDED_ANNOTATORS_ENDPOINT_PLACEHOLDER";

export const PROTOCOL_VERSION_0_1 = "0.1";

/** All protocol versions recognized by this verifier build. */
export const KNOWN_PROTOCOL_VERSIONS = ["0.1"] as const;

export type ProtocolVersion = typeof KNOWN_PROTOCOL_VERSIONS[number];
