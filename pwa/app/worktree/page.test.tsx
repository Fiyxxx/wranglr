/// <reference lib="dom" />
import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { TerminalWorkspace } from "../../components/TerminalWorkspace";
import { WranglrContext, type WranglrState } from "../../lib/store";

function state(overrides: Partial<WranglrState> = {}): WranglrState {
  return {
    connectionStatus: "open",
    worktrees: [{ path: "/repo/feature-x", herdrPaneId: "w1:p1", state: "working" }],
    hookEvents: [],
    pendingApprovals: [],
    promptResults: [],
    terminals: {},
    ...overrides,
  };
}

function renderWorkspace(value: WranglrState, send = (_msg: unknown) => {}) {
  render(
    <WranglrContext.Provider value={{ state: value, send: send as never }}>
      <TerminalWorkspace initialWorktreePath="/repo/feature-x" />
    </WranglrContext.Provider>,
  );
}

describe("TerminalWorkspace", () => {
  test("renders the selected Herdr session", () => {
    renderWorkspace(state());
    expect(screen.getAllByText("feature-x").length).toBeGreaterThan(0);
    expect(screen.getByText("reading pane output…")).toBeTruthy();
  });

  test("approves and rejects a pending request", () => {
    const sent: unknown[] = [];
    renderWorkspace(state({
      pendingApprovals: [{ id: "req-1", worktreePath: "/repo/feature-x", tool: "Bash", input: {}, risk: "high" }],
    }), (message) => sent.push(message));

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(sent).toEqual([
      { type: "approval_response", id: "req-1", decision: "approve" },
      { type: "approval_response", id: "req-1", decision: "reject" },
    ]);
  });

  test("sends direct terminal keys to the selected pane", () => {
    const sent: unknown[] = [];
    renderWorkspace(state(), (message) => sent.push(message));
    fireEvent.click(screen.getByRole("button", { name: "Esc" }));
    expect(sent).toContainEqual({ type: "terminal_input", paneId: "w1:p1", keys: ["esc"] });
  });
});
