// packages/protocol/test/index.test.ts
import { describe, expect, test } from "bun:test";
import {
  ApprovalRequestSchema,
  ApprovalResponseSchema,
  HookEventSchema,
  PromptSchema,
  ServerMessageSchema,
  ClientMessageSchema,
  VerificationResultSchema,
  WorktreeStatusSchema,
} from "../src/index";

describe("protocol schemas", () => {
  test("parses a valid worktree_status message", () => {
    const msg = {
      type: "worktree_status",
      worktrees: [
        { path: "/repo/feature-x", herdrPaneId: "w1:p1", state: "idle" as const },
      ],
    };
    expect(WorktreeStatusSchema.parse(msg)).toEqual(msg);
    expect(ServerMessageSchema.parse(msg)).toEqual(msg);
  });

  test("parses a valid approval_request message", () => {
    const msg = {
      type: "approval_request",
      id: "req-1",
      worktreePath: "/repo/feature-x",
      tool: "Bash",
      input: { command: "rm -rf node_modules" },
      risk: "high" as const,
    };
    expect(ApprovalRequestSchema.parse(msg)).toEqual(msg);
  });

  test("rejects an approval_response with a bad decision value", () => {
    const bad = { type: "approval_response", id: "req-1", decision: "maybe" };
    expect(() => ClientMessageSchema.parse(bad)).toThrow();
  });

  test("parses hook_event, verification_result, and prompt messages", () => {
    const hook = {
      type: "hook_event",
      hook: "PostToolUse" as const,
      worktreePath: "/repo/feature-x",
      tool: "Edit",
      input: { file_path: "/repo/feature-x/a.ts" },
      output: null,
    };
    expect(HookEventSchema.parse(hook)).toEqual(hook);

    const verification = {
      type: "verification_result",
      id: "req-1",
      passed: true,
      details: "42 tests passed",
    };
    expect(VerificationResultSchema.parse(verification)).toEqual(verification);

    const prompt = { type: "prompt", worktreePath: "/repo/feature-x", text: "continue" };
    expect(PromptSchema.parse(prompt)).toEqual(prompt);
    expect(ClientMessageSchema.parse(prompt)).toEqual(prompt);

    const response = { type: "approval_response", id: "req-1", decision: "approve" as const };
    expect(ApprovalResponseSchema.parse(response)).toEqual(response);
  });
});
