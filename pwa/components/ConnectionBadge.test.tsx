/// <reference lib="dom" />
import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { ConnectionBadge } from "./ConnectionBadge";
import { WranglrContext } from "../lib/store";
import type { WranglrState } from "../lib/store";

function renderWithStatus(status: WranglrState["connectionStatus"]) {
  const state: WranglrState = { connectionStatus: status, worktrees: [], hookEvents: [], pendingApprovals: [], promptResults: [], terminals: {} };
  render(
    <WranglrContext.Provider value={{ state, send: () => {} }}>
      <ConnectionBadge />
    </WranglrContext.Provider>,
  );
}

describe("ConnectionBadge", () => {
  test("shows Connected when open", () => {
    renderWithStatus("open");
    expect(screen.getByText("Connected")).toBeTruthy();
  });

  test("shows Connecting… when connecting", () => {
    renderWithStatus("connecting");
    expect(screen.getByText("Connecting…")).toBeTruthy();
  });

  test("shows Disconnected when closed", () => {
    renderWithStatus("closed");
    expect(screen.getByText("Disconnected")).toBeTruthy();
  });
});
