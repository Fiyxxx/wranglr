/// <reference lib="dom" />
import { describe, expect, test } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { WorktreeDetail } from "./page";
import { WranglrContext, type WranglrState } from "../../lib/store";

function state(overrides: Partial<WranglrState> = {}): WranglrState {
  return { connectionStatus: "open", worktrees: [], hookEvents: [], pendingApprovals: [], promptResults: [], ...overrides };
}

function renderWithState(value: WranglrState, send = (_msg: unknown) => {}) {
  render(<WranglrContext.Provider value={{ state: value, send: send as never }}><WorktreeDetail worktreePath="/repo/feature-x" /></WranglrContext.Provider>);
}

describe("WorktreeDetail", () => {
  test("renders scoped activity and approval details", () => {
    renderWithState(state({
      hookEvents: [
        { type: "hook_event", hook: "PreToolUse", worktreePath: "/repo/feature-x", tool: "Read", input: {}, output: null },
        { type: "hook_event", hook: "PreToolUse", worktreePath: "/repo/other", tool: "OtherTool", input: {}, output: null },
      ],
      pendingApprovals: [{ id: "1", worktreePath: "/repo/feature-x", tool: "Bash", input: { command: "bun test" }, risk: "high" }],
    }));

    expect(screen.getByText("Read")).toBeTruthy();
    expect(screen.queryByText("OtherTool")).toBeNull();
    expect(screen.getByText(/bun test/)).toBeTruthy();
  });

  test("approves and rejects a pending request", () => {
    const sent: unknown[] = [];
    renderWithState(state({ pendingApprovals: [{ id: "req-1", worktreePath: "/repo/feature-x", tool: "Bash", input: {}, risk: "high" }] }), (message) => sent.push(message));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(sent).toEqual([
      { type: "approval_response", id: "req-1", decision: "approve" },
      { type: "approval_response", id: "req-1", decision: "reject" },
    ]);
  });

  test("submits a prompt with an id", () => {
    const sent: Array<Record<string, unknown>> = [];
    renderWithState(state(), (message) => sent.push(message as Record<string, unknown>));
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "run the tests" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(sent[0]).toMatchObject({ type: "prompt", worktreePath: "/repo/feature-x", text: "run the tests" });
    expect(sent[0].id).toBeString();
  });

});
