/// <reference lib="dom" />
import { describe, expect, test, beforeEach } from "bun:test";
import { savePairing, loadPairing, clearPairing, parsePairingPayload, wsUrl } from "./pairing";

beforeEach(() => {
  localStorage.clear();
});

describe("pairing storage", () => {
  test("round-trips through localStorage", () => {
    expect(loadPairing()).toBeNull();
    savePairing({ hostname: "100.64.1.2", port: 7420, token: "tok" });
    expect(loadPairing()).toEqual({ hostname: "100.64.1.2", port: 7420, token: "tok" });
  });

  test("clearPairing removes it", () => {
    savePairing({ hostname: "100.64.1.2", port: 7420, token: "tok" });
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
    expect(parsePairingPayload(payload)).toEqual({ hostname: "100.64.1.2", port: 7420, token: "tok" });
  });

  test("returns null for invalid JSON", () => {
    expect(parsePairingPayload("garbage")).toBeNull();
  });

  test("returns null when required fields are missing", () => {
    expect(parsePairingPayload(JSON.stringify({ hostname: "x" }))).toBeNull();
  });
});

describe("wsUrl", () => {
  test("builds a ws:// url with the token as a query param", () => {
    expect(wsUrl({ hostname: "100.64.1.2", port: 7420, token: "tok" })).toBe("ws://100.64.1.2:7420/?token=tok");
  });
});
