import { describe, it, expect } from "vitest";
import { extractProtocolVersion } from "../src/version.js";
import { CardProtocolError } from "../src/errors.js";

describe("extractProtocolVersion", () => {
  it("returns '0.1' for a valid v0.1 document", () => {
    expect(extractProtocolVersion({ protocol_version: "0.1" })).toBe("0.1");
  });

  it("throws MISSING_PROTOCOL_VERSION when field is absent", () => {
    let caught: unknown;
    try {
      extractProtocolVersion({});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CardProtocolError);
    expect((caught as CardProtocolError).code).toBe("MISSING_PROTOCOL_VERSION");
  });

  it("throws UNKNOWN_PROTOCOL_VERSION for an unrecognized version string", () => {
    let caught: unknown;
    try {
      extractProtocolVersion({ protocol_version: "99.0" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CardProtocolError);
    expect((caught as CardProtocolError).code).toBe("UNKNOWN_PROTOCOL_VERSION");
  });

  it("throws MISSING_PROTOCOL_VERSION when field is a number rather than a string", () => {
    let caught: unknown;
    try {
      extractProtocolVersion({ protocol_version: 1 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CardProtocolError);
    expect((caught as CardProtocolError).code).toBe("MISSING_PROTOCOL_VERSION");
  });
});
