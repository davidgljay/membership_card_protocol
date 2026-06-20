import { describe, it, expect } from "vitest";
import { CardProtocolError } from "../src/errors.js";

describe("CardProtocolError", () => {
  it("is an instance of Error and CardProtocolError", () => {
    const err = new CardProtocolError("INVALID_PUBLIC_KEY_LENGTH", "key must be 1312 bytes");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CardProtocolError);
  });

  it("exposes code and message", () => {
    const err = new CardProtocolError("DECRYPTION_FAILED", "auth failure");
    expect(err.code).toBe("DECRYPTION_FAILED");
    expect(err.message).toBe("auth failure");
    expect(err.name).toBe("CardProtocolError");
  });
});
