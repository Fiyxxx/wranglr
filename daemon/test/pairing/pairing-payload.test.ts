import { describe, expect, test } from "bun:test";
import { buildPairingPayload } from "../../src/pairing/pairing-payload";

describe("buildPairingPayload", () => {
  test("serializes connection details as JSON", () => {
    const payload = buildPairingPayload("machine.tailnet.ts.net", 8443, "secret-token", true);
    expect(JSON.parse(payload)).toEqual({
      hostname: "machine.tailnet.ts.net",
      port: 8443,
      token: "secret-token",
      secure: true,
    });
  });
});
