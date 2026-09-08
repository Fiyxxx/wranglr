/// <reference lib="dom" />
import { describe, expect, test } from "bun:test";
import { urlBase64ToArrayBuffer } from "./push";

describe("urlBase64ToArrayBuffer", () => {
  test("decodes a URL-safe base64 VAPID key into an ArrayBuffer", () => {
    // "SGVsbG8" (URL-safe, no padding) decodes to the ASCII bytes for "Hello"
    const result = urlBase64ToArrayBuffer("SGVsbG8");
    expect(Array.from(new Uint8Array(result))).toEqual([72, 101, 108, 108, 111]);
  });
});
