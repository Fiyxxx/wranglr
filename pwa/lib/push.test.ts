/// <reference lib="dom" />
import { describe, expect, test } from "bun:test";
import { urlBase64ToUint8Array } from "./push";

describe("urlBase64ToUint8Array", () => {
  test("decodes a URL-safe base64 VAPID key into a Uint8Array", () => {
    // "SGVsbG8" (URL-safe, no padding) decodes to the ASCII bytes for "Hello"
    const result = urlBase64ToUint8Array("SGVsbG8");
    expect(Array.from(result)).toEqual([72, 101, 108, 108, 111]);
  });
});
