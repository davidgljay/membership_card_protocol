/**
 * Writes `notary/vectors/messaging/ts_blob.json`: a `notary_output` message fanned out by the App SDK's real
 * `fanOutMessageToSubCards` to an ML-KEM-768 sub-card key from a fixed seed. Rust (`notary-messaging`) must decrypt it.
 * The encryption is randomised (the App SDK draws its own nonce), so the file is committed as a static vector, not
 * regenerated in CI: rerun only on purpose (`pnpm run gen:messaging`).
 */
import { writeFileSync } from "node:fs";
import { fanOutMessageToSubCards, mlKem768GenerateKeypair } from "@membership-card-protocol/app-sdk";
import { b64uEncode } from "@membership-card-protocol/verifier/notary";

export const KEM_SEED = Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 3) & 0xff);
const kp = mlKem768GenerateKeypair(KEM_SEED);
const envelope = {
  payload: { type: "notary_output", content: { job_hash: "jh", notarization: "bafkreinotarization", output: { count: 12, sum: 345 }, output_hash: "oh" },
    recipients: ["r".repeat(64)], senders: ["s".repeat(64)], protocol_version: "0.1", timestamp: "2026-11-14T10:00:00.000Z" },
  signatures: [{ public_key: "pk", signature: "sig" }],
};
const [routing] = fanOutMessageToSubCards("r".repeat(64), envelope as never, [{ subCardHash: "sub".repeat(21) + "x", mlKemPublicKey: kp.publicKey }]);
writeFileSync(new URL("../../vectors/messaging/ts_blob.json", import.meta.url), JSON.stringify({
  about: "A notary_output message fanned out by the App SDK (fanOutMessageToSubCards) to the ML-KEM-768 key of the seed below. notary-messaging must decrypt it. Static: encryption is randomised.",
  kem_seed: b64uEncode(KEM_SEED), kem_public_key: b64uEncode(kp.publicKey), envelope, routing,
}, null, 1) + "\n");
console.log("wrote vectors/messaging/ts_blob.json");
