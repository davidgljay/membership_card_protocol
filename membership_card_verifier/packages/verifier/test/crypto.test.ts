import { describe, it, expect } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
import { keccak256, hkdfSha3256, aes256gcmDecrypt, mlDsa44Verify } from "../src/crypto.js";
import { CardProtocolError } from "../src/errors.js";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { hkdf } from "@noble/hashes/hkdf";
import { sha3_256 } from "@noble/hashes/sha3";

describe("keccak256", () => {
  it("empty input produces known hash", () => {
    expect(keccak256(new Uint8Array(0))).toBe(
      "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
    );
  });
});

describe("hkdfSha3256", () => {
  it("matches reference output for fixed ikm and info", () => {
    const ikm = new Uint8Array(32).fill(0x42);
    const info = "card-content-v1";
    const result = hkdfSha3256(ikm, info);
    // Reference: compute expected offline using same algorithm
    const expected = hkdf(sha3_256, ikm, undefined, new TextEncoder().encode(info), 32);
    expect(result).toEqual(expected);
    expect(result.length).toBe(32);
  });
});

describe("aes256gcmDecrypt", () => {
  function encrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Uint8Array {
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return new Uint8Array(Buffer.concat([nonce, ciphertext, tag]));
  }

  it("decrypts a valid ciphertext", async () => {
    const key = new Uint8Array(randomBytes(32));
    const nonce = new Uint8Array(randomBytes(12));
    const plaintext = new TextEncoder().encode("hello, card protocol");
    const encrypted = encrypt(key, nonce, plaintext);
    const decrypted = await aes256gcmDecrypt(key, encrypted);
    expect(decrypted).toEqual(plaintext);
  });

  it("throws CardProtocolError on tampered ciphertext", async () => {
    const key = new Uint8Array(randomBytes(32));
    const nonce = new Uint8Array(randomBytes(12));
    const plaintext = new TextEncoder().encode("secret");
    const encrypted = encrypt(key, nonce, plaintext);
    // Flip a byte in the ciphertext body (after nonce, before tag)
    encrypted[13] ^= 0xff;
    let caught: unknown;
    try {
      await aes256gcmDecrypt(key, encrypted);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CardProtocolError);
    expect((caught as CardProtocolError).code).toBe("DECRYPTION_FAILED");
  });
});

describe("mlDsa44Verify", () => {
  // @noble/post-quantum API: sign(msg, secretKey), verify(sig, msg, publicKey)
  it("returns true for a valid signature", () => {
    const { secretKey, publicKey } = ml_dsa44.keygen();
    const message = new TextEncoder().encode("test message");
    const sig = ml_dsa44.sign(message, secretKey);
    expect(mlDsa44Verify(publicKey, message, sig)).toBe(true);
  });

  it("returns false for a flipped byte in signature", () => {
    const { secretKey, publicKey } = ml_dsa44.keygen();
    const message = new TextEncoder().encode("test message");
    const sig = ml_dsa44.sign(message, secretKey);
    // Flip a byte in the middle of the signature
    const tampered = new Uint8Array(sig);
    tampered[1200] ^= 0xff;
    expect(mlDsa44Verify(publicKey, message, tampered)).toBe(false);
  });
});
