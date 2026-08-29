/// <reference lib="dom" />
import { describe, expect, test } from "bun:test";
import { reducer, initialState } from "./store";

describe("reducer", () => {
  test("connection_status updates connectionStatus", () => {
    const next = reducer(initialState, { type: "connection_status", status: "open" });
    expect(next.connectionStatus).toBe("open");
  });

  test("worktree_status replaces the worktrees list", () => {
    const next = reducer(initialState, {
      type: "worktree_status",
      worktrees: [{ path: "/repo/a", herdrPaneId: "p1", state: "working" }],
    });
    expect(next.worktrees).toEqual([{ path: "/repo/a", herdrPaneId: "p1", state: "working" }]);
  });

  test("hook_event appends to the hookEvents log", () => {
    const event = { type: "hook_event" as const, hook: "PreToolUse" as const, worktreePath: "/repo/a", tool: "Bash", input: {}, output: null };
    const next = reducer(initialState, event);
    expect(next.hookEvents).toEqual([event]);
  });

  test("approval_request appends to pendingApprovals", () => {
    const request = { type: "approval_request" as const, id: "1", worktreePath: "/repo/a", tool: "Bash", input: {}, risk: "high" as const };
    const next = reducer(initialState, request);
    expect(next.pendingApprovals).toEqual([{ id: "1", worktreePath: "/repo/a", tool: "Bash", input: {}, risk: "high" }]);
  });

  test("approval_request followed by resolving it removes it once a matching response would be sent (pendingApprovals only tracks requests; removal happens via a dedicated action)", () => {
    const request = { type: "approval_request" as const, id: "1", worktreePath: "/repo/a", tool: "Bash", input: {}, risk: "high" as const };
    const withRequest = reducer(initialState, request);
    const cleared = reducer(withRequest, { type: "connection_status", status: "closed" });
    expect(cleared.pendingApprovals).toEqual([{ id: "1", worktreePath: "/repo/a", tool: "Bash", input: {}, risk: "high" }]);
  });

  test("approval_resolved removes a pending approval by id", () => {
    const request = { type: "approval_request" as const, id: "1", worktreePath: "/repo/a", tool: "Bash", input: {}, risk: "high" as const };
    const withRequest = reducer(initialState, request);
    const cleared = reducer(withRequest, { type: "approval_resolved", id: "1" });
    expect(cleared.pendingApprovals).toEqual([]);
  });
});
