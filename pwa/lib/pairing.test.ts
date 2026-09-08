/// <reference lib="dom" />
import { describe, expect, test, beforeEach } from "bun:test";
import { savePairing, loadPairing, clearPairing, parsePairingPayload, wsUrl, apiUrl } from "./pairing";

beforeEach(() => {
  localStorage.clear();
});

describe("pairing storage", () => {
  test("round-trips through localStorage", () => {
    expect(loadPairing()).toBeNull();
    savePairing({ hostname: "100.64.1.2", port: 7420, token: "tok", secure: false });
    expect(loadPairing()).toEqual({ hostname: "100.64.1.2", port: 7420, token: "tok", secure: false });
  });

  test("clearPairing removes it", () => {
    savePairing({ hostname: "100.64.1.2", port: 7420, token: "tok", secure: false });
    clearPairing();
    expect(loadPairing()).toBeNull();
  });

  test("loadPairing returns null for malformed stored JSON", () => {
    localStorage.setItem("wranglr.pairing", "not json");
    expect(loadPairing()).toBeNull();
  });
});

describe("parsePairingPayload", () => {
  test("parses a valid QR payload", () => {
    const payload = JSON.stringify({ hostname: "100.64.1.2", port: 7420, token: "tok" });
    expect(parsePairingPayload(payload)).toEqual({ hostname: "100.64.1.2", port: 7420, token: "tok", secure: false });
  });

  test("returns null for invalid JSON", () => {
    expect(parsePairingPayload("garbage")).toBeNull();
  });

  test("returns null when required fields are missing", () => {
    expect(parsePairingPayload(JSON.stringify({ hostname: "x" }))).toBeNull();
  });
});

describe("wsUrl", () => {
  test("builds ws and wss URLs with an encoded token", () => {
    expect(wsUrl({ hostname: "100.64.1.2", port: 7420, token: "tok value", secure: false })).toBe("ws://100.64.1.2:7420/?token=tok%20value");
    expect(wsUrl({ hostname: "machine.ts.net", port: 8443, token: "tok", secure: true })).toBe("wss://machine.ts.net:8443/?token=tok");
  });

  test("builds secure API URLs", () => {
    expect(apiUrl({ hostname: "machine.ts.net", port: 8443, token: "tok", secure: true }, "/vapid-public-key"))
      .toBe("https://machine.ts.net:8443/vapid-public-key?token=tok");
  });
});
