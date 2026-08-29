import { describe, expect, test } from "bun:test";
import { buildPairingPayload } from "../../src/pairing/pairing-payload";

describe("buildPairingPayload", () => {
  test("serializes hostname, port, and token as JSON", () => {
    const payload = buildPairingPayload("100.64.1.2", 7420, "secret-token");
    expect(JSON.parse(payload)).toEqual({ hostname: "100.64.1.2", port: 7420, token: "secret-token" });
  });
});
