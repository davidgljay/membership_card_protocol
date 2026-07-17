/**
 * Integration tests against the live Card Protocol storage contract.
 *
 * Skipped by default. Run with:
 *   ENV=dev pnpm test:integration        (Arbitrum Sepolia)
 *   ENV=prod pnpm test:integration       (mainnet — not yet configured)
 *
 * Requires:
 *   - ENV=dev or ENV=prod
 *   - Network access to the Arbitrum RPC endpoint
 *
 * These tests call the actual deployed Stylus contracts. No wallet or
 * private key is required — all calls are read-only.
 *
 * ABI note: Stylus SDK 0.8 maps Vec<u8> → uint8[] (NOT bytes).
 * Each byte is ABI-padded to 32 bytes. The helpers below handle the
 * conversion back to hex strings.
 */
import { describe, it, expect } from "vitest";
import { JsonRpcProvider, Contract } from "ethers";
import { EthersRpcProvider, getNetworkConfig } from "../src/index.js";
import { CardVerifier } from "@membership-card-protocol/verifier";
import type { RegistryContract } from "../src/index.js";
import type { IpfsProvider } from "@membership-card-protocol/verifier";

// ─── Test fixtures ────────────────────────────────────────────────────────────
// From contracts/mock_wallets/card_test_verifier_card_v5.json
//
// Address derivation: card_address = press_address = keccak256(press_secp256r1_pubkey_bytes)
// The SHA-256("card_protocol_<id>") scheme used in prior deployments was incorrect;
// test_03_create_card.sh has been fixed and the registry needs re-registration.

/**
 * Correct card address: keccak256(press_secp256r1_public_key_bytes).
 * Equals the press address and the verifier's signer_card for verifyEnvelope.
 * NOTE: the on-chain state at this address is not yet registered (requires re-running
 * test_03_create_card.sh). The verifyCard tests below will get CARD_NOT_FOUND until
 * re-registration is complete.
 */
const SEPOLIA_TEST_CARD = "0xd3926c64d0432a9b6b4de712e8ed2bd6af61488aba11b79769530132c9ca118c";

/** Policy address for the test card (SHA-256("card_protocol_test_verifier_policy_v1") — unchanged). */
const SEPOLIA_TEST_POLICY = "0x41fc35de7586b44d70c116d242119956661d7a9a6481dfde02b08e2097239320";

/**
 * Signed message envelope from contracts/mock_wallets/signed_message_test_verifier_card_v5.json.
 *
 * Signed by the press (test_verifier_press_v1) using secp256r1_phase1:
 *   SHA-256(canonical_payload_bytes) → ECDSA P-256 sign (r||s, 64 bytes)
 *
 * The senders/recipients in this payload still reference the old SHA-256-derived address
 * (0xb6b51b1d...) because the signature is bound to that exact payload. Re-run
 * test_05_sign_test_message.sh after re-registration to get a fresh envelope with the
 * correct address (0xd3926c64...).
 *
 * The secp256r1 signature itself remains valid regardless of the address in the payload —
 * stage 1 (cryptographic check) still passes, which is what the verifyEnvelope tests assert.
 */
const SIGNED_MESSAGE_ENVELOPE = {
  payload: {
    content: "test message",
    recipients: ["0xb6b51b1d567453d1733aab87c1c1a4bb1504ccdd0e278ad92a780949d0dcdc0b"],
    senders: ["0xb6b51b1d567453d1733aab87c1c1a4bb1504ccdd0e278ad92a780949d0dcdc0b"],
    timestamp: "2026-06-24T04:21:29Z",
    type: "text",
  },
  signatures: [
    {
      key_scheme: "secp256r1_phase1" as const,
      public_key: "uT6wuk_KVB41NyBRFqJJecJ7JyPoySseCdFAA3RDr6OKUpeYpct7U46ooL6_S-VHLkkWSfNB-3_R9SWLYP_bng",
      signature: "kaH2WE3p6zAyQqLcVck_ma2MDDLDYpkOEkyNj-leUG85Kn7isFTI5tKp3xWY9ZmgO9vwJRKmB3osGwH6-UVSDA",
    },
  ],
};

/**
 * keccak256(base64url_decode(public_key)) — the signer_card the verifier derives.
 * In Phase 1 this equals the card_address and press_address (same key, same hash).
 */
const PRESS_SIGNER_CARD = "d3926c64d0432a9b6b4de712e8ed2bd6af61488aba11b79769530132c9ca118c";

// ─── ABI fragments ────────────────────────────────────────────────────────────
// Only the read functions needed for verifyCard() are included.
//
// Stylus SDK 0.8 quirks:
//   1. Vec<u8> maps to uint8[] (NOT bytes) — each byte is ABI-padded to 32 bytes.
//   2. Multi-return with dynamic types is wrapped in an extra outer tuple offset.
//      Declaring the return as a single named tuple makes ethers decode it correctly.
const STORAGE_ABI = [
  "function getCardEntry(bytes32 card_address) view returns (tuple(uint8[] log_head_cid, bytes32 policy_address, bytes32 last_press_address, bytes32 forward_to, bool exists) r)",
  "function policyExists(bytes32 policy_address) view returns (bool)",
];

// ─── Conversion helpers ───────────────────────────────────────────────────────

/** Convert a uint8[] result (array of bigints) from ethers into a 0x hex string. */
function uint8ArrayResultToHex(arr: bigint[]): string {
  if (arr.length === 0) return "0x";
  return "0x" + arr.map((b) => Number(b).toString(16).padStart(2, "0")).join("");
}

const ZERO_BYTES32 = "0x" + "00".repeat(32);

// ─── RegistryContract adapter ─────────────────────────────────────────────────

/**
 * Wraps an ethers.js Contract to implement the RegistryContract interface.
 *
 * Handles the uint8[] → hex string conversion for CID fields.
 * getCardEventLog and getEasAnnotations are not available as simple contract
 * reads (they require replaying/indexing events) so they return empty arrays;
 * verifyCard() treats an empty event log as "no on-chain history", which is
 * correct for a freshly registered test card.
 */
/** Ensure an address has a 0x prefix for ethers.js bytes32 encoding. */
function toBytes32(address: string): string {
  return address.startsWith("0x") ? address : "0x" + address;
}

function buildRegistryContract(contract: Contract): RegistryContract {
  return {
    async getCardEntry(address: string) {
      // Returns a single named tuple (Stylus SDK 0.8 outer-tuple-offset encoding).
      const result = (await contract.getCardEntry(toBytes32(address))) as {
        log_head_cid: bigint[];
        policy_address: string;
        last_press_address: string;
        forward_to: string;
        exists: boolean;
      };
      return {
        log_head_cid: uint8ArrayResultToHex(result.log_head_cid),
        policy_address: result.policy_address,
        last_press_address: result.last_press_address,
        forward_to: result.forward_to === ZERO_BYTES32 ? null : result.forward_to,
        exists: result.exists,
      };
    },

    async isPolicyAuthorizer(address: string) {
      return (await contract.policyExists(toBytes32(address))) as boolean;
    },

    // Not used by verifyCard() — stubs return safe defaults.
    async getPressAuthorization() {
      return null;
    },
    async getSubCardEntry() {
      return null;
    },
    async getCardEventLog() {
      return [];
    },
    async getEasAnnotations() {
      return [];
    },
  };
}

// ─── Stub IPFS provider ───────────────────────────────────────────────────────
// verifyCard() never fetches IPFS. verifyEnvelope() reaches Stage 2 which does
// fetch IPFS, but only after getCardEntry succeeds — if the press is not a card,
// Stage 2 fails before any IPFS call with CARD_NOT_FOUND, so the stub is safe.
// If the press IS a card, Stage 2 will attempt an IPFS fetch and get an error,
// resulting in scope_clean: false (acceptable — the test only asserts Stage 1).
const stubIpfs: IpfsProvider = {
  fetch: async (cid: string) => {
    throw new Error(`IPFS fetch not available in integration test (CID: ${cid})`);
  },
};

// ─── Test suite ───────────────────────────────────────────────────────────────
//
// On-chain registration status
// ─────────────────────────────
// The verifyCard tests require the card at SEPOLIA_TEST_CARD (0xd3926c64...) to be
// registered on Sepolia. The prior deployment used incorrect SHA-256 name-based
// addresses; the corrected test_03_create_card.sh now derives addresses as
// keccak256(press_pubkey_bytes). Re-run that script to register at the correct
// address and the verifyCard tests will pass.
//
// Until then:
//   FAILING (needs re-registration): verifyCard tests
//   PASSING  (no on-chain card needed): isPolicyAuthorizer, verifyEnvelope tests

const ENV = process.env["ENV"];
const isIntegration = ENV === "dev" || ENV === "prod";

describe.skipIf(!isIntegration)(`Sepolia integration (ENV=${ENV ?? "unset"})`, () => {
  let verifier: CardVerifier;

  // Set up the verifier once for the suite.
  // We can't use beforeAll with describe.skipIf cleanly, so we lazily build it in each test.
  function makeVerifier(): CardVerifier {
    const networkConfig = getNetworkConfig();
    const provider = new JsonRpcProvider(networkConfig.rpcUrl);
    const ethersContract = new Contract(networkConfig.storageContractAddress, STORAGE_ABI, provider);
    const registryContract = buildRegistryContract(ethersContract);
    const rpcProvider = new EthersRpcProvider(registryContract);
    return new CardVerifier({ rpc: rpcProvider, ipfs: stubIpfs });
  }

  // Requires on-chain re-registration at 0xd3926c64... (run test_03_create_card.sh).
  it("verifyCard: test card is registered on-chain (no CARD_NOT_FOUND error)", async () => {
    verifier = makeVerifier();
    const result = await verifier.verifyCard(SEPOLIA_TEST_CARD);

    expect(result.signer_card).toBe(SEPOLIA_TEST_CARD);
    expect(result.signature_valid).toBeNull();

    const cardNotFound = result.errors.filter((e) => e.code === "CARD_NOT_FOUND");
    expect(cardNotFound).toHaveLength(0);
  }, 30_000);

  // Requires on-chain re-registration at 0xd3926c64... (run test_03_create_card.sh).
  it("verifyCard: revocation status is not_revoked for a live test card", async () => {
    verifier = makeVerifier();
    const result = await verifier.verifyCard(SEPOLIA_TEST_CARD);

    expect(result.revocation.status).toBe("not_revoked");
    expect(result.is_currently_valid).toBe(true);
    expect(result.was_valid_at_signing_time).toBe(true);
  }, 30_000);

  // Requires on-chain re-registration at 0xd3926c64... (run test_03_create_card.sh).
  it("verifyCard: test policy address is not a trusted root for the card", async () => {
    verifier = makeVerifier();
    // The policy address is not the card address — isPolicyAuthorizer on the card itself
    // returns false (cards are not policy registries).
    const result = await verifier.verifyCard(SEPOLIA_TEST_CARD);
    // chain_reaches_trusted_root is false unless trustedRoots is configured or card IS a policy
    expect(result.chain_reaches_trusted_root).toBe(false);
  }, 30_000);

  // Requires on-chain re-registration at 0xd3926c64... (run test_03_create_card.sh).
  it("verifyCard: test card with explicit trusted root reaches root", async () => {
    const networkConfig = getNetworkConfig();
    const provider = new JsonRpcProvider(networkConfig.rpcUrl);
    const ethersContract = new Contract(networkConfig.storageContractAddress, STORAGE_ABI, provider);
    const rpcProvider = new EthersRpcProvider(buildRegistryContract(ethersContract));

    // Treating the test card itself as a trusted root for this assertion.
    const verifierWithRoot = new CardVerifier({
      rpc: rpcProvider,
      ipfs: stubIpfs,
      trustedRoots: [SEPOLIA_TEST_CARD],
    });

    const result = await verifierWithRoot.verifyCard(SEPOLIA_TEST_CARD);
    expect(result.chain_reaches_trusted_root).toBe(true);
  }, 30_000);

  it("isPolicyAuthorizer: policy address is recognized by the storage contract", async () => {
    const networkConfig = getNetworkConfig();
    const provider = new JsonRpcProvider(networkConfig.rpcUrl);
    const ethersContract = new Contract(networkConfig.storageContractAddress, STORAGE_ABI, provider);
    const registryContract = buildRegistryContract(ethersContract);

    // The test policy should be registered in the storage contract.
    const isPolicyAuth = await registryContract.isPolicyAuthorizer(SEPOLIA_TEST_POLICY);
    expect(isPolicyAuth).toBe(true);
  }, 30_000);

  // ── Signed message envelope tests ────────────────────────────────────────────
  //
  // Source: contracts/mock_wallets/signed_message_test_verifier_card_v5.json
  //
  // The envelope was signed by the press (test_verifier_press_v1) using
  // secp256r1_phase1: SHA-256(canonical_payload_bytes) → ECDSA P-256 (r||s).
  //
  // Stage 1 (cryptographic): verifies the secp256r1 signature — asserted TRUE below.
  // Stage 2 (chain of trust): looks up keccak256(press_pubkey) = press_address as a
  //   card entry. The press is authorized as a press, not as a card holder, so Stage 2
  //   returns CARD_NOT_FOUND and scope_clean: false. This is expected Phase 1 behavior.
  //   Full press-to-card trust resolution is not yet implemented.

  it("verifyEnvelope: secp256r1_phase1 signature is cryptographically valid (stage 1)", async () => {
    verifier = makeVerifier();
    const result = await verifier.verifyEnvelope(SIGNED_MESSAGE_ENVELOPE);

    expect(result.signatures).toHaveLength(1);
    const sig = result.signatures[0]!;

    // Stage 1 must pass: the secp256r1 signature is valid.
    expect(sig.signature_valid).toBe(true);
  }, 30_000);

  it("verifyEnvelope: signer_card is keccak256 of the press secp256r1 public key", async () => {
    verifier = makeVerifier();
    const result = await verifier.verifyEnvelope(SIGNED_MESSAGE_ENVELOPE);

    const sig = result.signatures[0]!;
    expect(sig.signer_card).toBe(PRESS_SIGNER_CARD);
  }, 30_000);

  it("verifyEnvelope: no stage-1 errors (signature format and length valid)", async () => {
    verifier = makeVerifier();
    const result = await verifier.verifyEnvelope(SIGNED_MESSAGE_ENVELOPE);

    const sig = result.signatures[0]!;
    const stage1Errors = sig.errors.filter((e) => e.stage === 1);
    expect(stage1Errors).toHaveLength(0);
  }, 30_000);

  it("verifyEnvelope: envelope_id is a deterministic SHA-256 hex string", async () => {
    verifier = makeVerifier();
    const result = await verifier.verifyEnvelope(SIGNED_MESSAGE_ENVELOPE);

    // envelope_id = SHA-256(RFC-8785 canonical JSON of the full envelope)
    expect(result.envelope_id).toMatch(/^[0-9a-f]{64}$/);

    // Verify it is deterministic: running again produces the same id.
    const result2 = await verifier.verifyEnvelope(SIGNED_MESSAGE_ENVELOPE);
    expect(result2.envelope_id).toBe(result.envelope_id);
  }, 30_000);
});
