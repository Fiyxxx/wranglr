/// <reference lib="dom" />
import { describe, expect, test } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { WorktreeDetail } from "./page";
import { WranglrContext, type WranglrState } from "../../../lib/store";

function renderWithState(state: WranglrState, send = (_msg: unknown) => {}) {
  render(
    <WranglrContext.Provider value={{ state, send: send as never }}>
      <WorktreeDetail worktreePath="/repo/feature-x" />
    </WranglrContext.Provider>,
  );
}

describe("WorktreeDetail", () => {
  test("renders hook events scoped to this worktree only", () => {
    renderWithState({
      connectionStatus: "open",
      worktrees: [],
      hookEvents: [
        { type: "hook_event", hook: "PreToolUse", worktreePath: "/repo/feature-x", tool: "Read", input: {}, output: null },
        { type: "hook_event", hook: "PreToolUse", worktreePath: "/repo/other", tool: "Bash", input: {}, output: null },
      ],
      pendingApprovals: [],
    });

    expect(screen.getByText("Read")).toBeTruthy();
    expect(screen.queryByText("Bash")).toBeNull();
  });

  test("renders a pending approval for this worktree with approve/reject buttons", () => {
    renderWithState({
      connectionStatus: "open",
      worktrees: [],
      hookEvents: [],
      pendingApprovals: [{ id: "1", worktreePath: "/repo/feature-x", tool: "Bash", input: { command: "rm -rf /" }, risk: "high" }],
    });

    expect(screen.getByText("Bash")).toBeTruthy();
    expect(screen.getByText("high")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
  });

  test("clicking Approve sends an approval_response with decision approve and the request id", () => {
    const sent: unknown[] = [];
    renderWithState(
      {
        connectionStatus: "open",
        worktrees: [],
        hookEvents: [],
        pendingApprovals: [{ id: "req-1", worktreePath: "/repo/feature-x", tool: "Bash", input: {}, risk: "high" }],
      },
      (msg) => sent.push(msg),
    );

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(sent).toEqual([{ type: "approval_response", id: "req-1", decision: "approve" }]);
  });

  test("clicking Reject sends an approval_response with decision reject", () => {
    const sent: unknown[] = [];
    renderWithState(
      {
        connectionStatus: "open",
        worktrees: [],
        hookEvents: [],
        pendingApprovals: [{ id: "req-1", worktreePath: "/repo/feature-x", tool: "Bash", input: {}, risk: "high" }],
      },
      (msg) => sent.push(msg),
    );

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(sent).toEqual([{ type: "approval_response", id: "req-1", decision: "reject" }]);
  });

  test("submitting the prompt form sends a prompt ClientMessage for this worktree", () => {
    const sent: unknown[] = [];
    renderWithState(
      { connectionStatus: "open", worktrees: [], hookEvents: [], pendingApprovals: [] },
      (msg) => sent.push(msg),
    );

    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "run the tests" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(sent).toEqual([{ type: "prompt", worktreePath: "/repo/feature-x", text: "run the tests" }]);
  });
});
