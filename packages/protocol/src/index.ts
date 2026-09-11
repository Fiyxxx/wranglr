import { z } from "zod";

export const WorktreeStatusSchema = z.object({
  type: z.literal("worktree_status"),
  worktrees: z.array(
    z.object({
      path: z.string(),
      herdrPaneId: z.string().nullable(),
      state: z.enum(["idle", "working", "blocked", "done", "unknown"]),
    }),
  ),
});

export const HookEventSchema = z.object({
  type: z.literal("hook_event"),
  hook: z.enum(["PreToolUse", "PostToolUse"]),
  worktreePath: z.string(),
  tool: z.string(),
  input: z.record(z.string(), z.unknown()),
  output: z.record(z.string(), z.unknown()).nullable(),
});

export const ApprovalRequestSchema = z.object({
  type: z.literal("approval_request"),
  id: z.string(),
  worktreePath: z.string(),
  tool: z.string(),
  input: z.record(z.string(), z.unknown()),
  risk: z.enum(["low", "medium", "high"]),
});

export const VerificationResultSchema = z.object({
  type: z.literal("verification_result"),
  id: z.string(),
  passed: z.boolean(),
  details: z.string(),
});

export const ApprovalResponseSchema = z.object({
  type: z.literal("approval_response"),
  id: z.string(),
  decision: z.enum(["approve", "reject"]),
});

export const ApprovalResolvedSchema = z.object({
  type: z.literal("approval_resolved"),
  id: z.string(),
  decision: z.enum(["approve", "reject", "timeout"]),
});

export const PromptSchema = z.object({
  type: z.literal("prompt"),
  id: z.string(),
  worktreePath: z.string(),
  text: z.string(),
});

export const PromptResultSchema = z.object({
  type: z.literal("prompt_result"),
  id: z.string(),
  worktreePath: z.string(),
  accepted: z.boolean(),
  error: z.string().nullable(),
});

export const TerminalOutputSchema = z.object({
  type: z.literal("terminal_output"),
  paneId: z.string(),
  worktreePath: z.string(),
  mode: z.enum(["snapshot", "append"]),
  data: z.string(),
  revision: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export const TerminalInputSchema = z.object({
  type: z.literal("terminal_input"),
  paneId: z.string(),
  text: z.string().optional(),
  keys: z.array(z.string()).optional(),
});

export const ServerMessageSchema = z.discriminatedUnion("type", [
  WorktreeStatusSchema,
  HookEventSchema,
  ApprovalRequestSchema,
  ApprovalResolvedSchema,
  VerificationResultSchema,
  PromptResultSchema,
  TerminalOutputSchema,
]);

export const ClientMessageSchema = z.discriminatedUnion("type", [
  ApprovalResponseSchema,
  PromptSchema,
  TerminalInputSchema,
]);

export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
