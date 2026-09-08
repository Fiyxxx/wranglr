/// <reference lib="dom" />
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { render } from "@testing-library/react";
import Home from "./page";
import { savePairing, clearPairing } from "../lib/pairing";

const originalLocation = window.location;

beforeEach(() => {
  clearPairing();
  // @ts-expect-error -- overriding for the test, restored in afterEach
  delete window.location;
  // @ts-expect-error -- assigning a minimal stub
  window.location = { href: "" };
});

afterEach(() => {
  window.location = originalLocation;
});

describe("Home", () => {
  test("redirects to /pair when no pairing is saved", () => {
    render(<Home />);
    expect(window.location.href).toBe("/pair");
  });

  test("redirects to /dashboard when a pairing is already saved", () => {
    savePairing({ hostname: "100.64.1.2", port: 7420, token: "tok", secure: false });
    render(<Home />);
    expect(window.location.href).toBe("/dashboard");
  });
});
