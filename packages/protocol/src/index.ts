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

export const PromptSchema = z.object({
  type: z.literal("prompt"),
  worktreePath: z.string(),
  text: z.string(),
});

export const ServerMessageSchema = z.discriminatedUnion("type", [
  WorktreeStatusSchema,
  HookEventSchema,
  ApprovalRequestSchema,
  VerificationResultSchema,
]);

export const ClientMessageSchema = z.discriminatedUnion("type", [
  ApprovalResponseSchema,
  PromptSchema,
]);

export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
