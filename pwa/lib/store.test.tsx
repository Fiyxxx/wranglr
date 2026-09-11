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

  test("worktree_status drops terminals for panes no longer present", () => {
    const withTerminal = reducer(initialState, {
      type: "terminal_output",
      paneId: "p1",
      worktreePath: "/repo/a",
      mode: "snapshot",
      data: "hello",
      revision: 1,
      truncated: false,
    });
    expect(withTerminal.terminals["p1"]).toBeDefined();

    const next = reducer(withTerminal, {
      type: "worktree_status",
      worktrees: [{ path: "/repo/b", herdrPaneId: "p2", state: "working" }],
    });
    expect(next.terminals["p1"]).toBeUndefined();
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

  test("approval_request replaces a duplicate delivered after reconnect", () => {
    const request = { type: "approval_request" as const, id: "1", worktreePath: "/repo/a", tool: "Bash", input: {}, risk: "high" as const };
    const once = reducer(initialState, request);
    const twice = reducer(once, request);
    expect(twice.pendingApprovals).toHaveLength(1);
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
    const cleared = reducer(withRequest, { type: "approval_resolved", id: "1", decision: "approve" });
    expect(cleared.pendingApprovals).toEqual([]);
  });

  test("prompt_result records delivery feedback", () => {
    const result = { type: "prompt_result" as const, id: "p1", worktreePath: "/repo/a", accepted: true, error: null };
    expect(reducer(initialState, result).promptResults).toEqual([result]);
  });

  test("terminal_output preserves a full pane and appends incremental output", () => {
    const snapshot = reducer(initialState, {
      type: "terminal_output",
      paneId: "p1",
      worktreePath: "/repo/a",
      mode: "snapshot",
      data: "hello",
      revision: 1,
      truncated: false,
    });
    const appended = reducer(snapshot, {
      type: "terminal_output",
      paneId: "p1",
      worktreePath: "/repo/a",
      mode: "append",
      data: " world",
      revision: 2,
      truncated: false,
    });
    expect(appended.terminals.p1?.content).toBe("hello world");
    expect(appended.terminals.p1?.lastData).toBe(" world");
  });
});
