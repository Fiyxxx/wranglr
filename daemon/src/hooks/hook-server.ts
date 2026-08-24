import type { ServerMessage } from "@wranglr/protocol";
import { z } from "zod";
import type { EventBus } from "../event-bus";

const HookPayloadSchema = z.object({
  hook_event_name: z.enum(["PreToolUse", "PostToolUse"]),
  cwd: z.string(),
  tool_name: z.string(),
  tool_input: z.record(z.string(), z.unknown()),
  tool_response: z.record(z.string(), z.unknown()).optional(),
});

export interface HookServerOptions {
  port: number;
  bus: EventBus<ServerMessage>;
  onPreToolUse?: (event: { worktreePath: string; tool: string; input: Record<string, unknown> }) => void;
}

export function startHookServer(options: HookServerOptions): { stop: () => void; port: number } {
  const server = Bun.serve({
    port: options.port,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.method !== "POST" || new URL(req.url).pathname !== "/hook") {
        return new Response("not found", { status: 404 });
      }
      const body = await req.json().catch(() => null);
      const parsed = HookPayloadSchema.safeParse(body);
      if (!parsed.success) {
        return new Response("bad request", { status: 400 });
      }

      const { hook_event_name, cwd, tool_name, tool_input, tool_response } = parsed.data;

      options.bus.publish({
        type: "hook_event",
        hook: hook_event_name,
        worktreePath: cwd,
        tool: tool_name,
        input: tool_input,
        output: tool_response ?? null,
      });

      if (hook_event_name === "PreToolUse") {
        options.onPreToolUse?.({ worktreePath: cwd, tool: tool_name, input: tool_input });
      }

      return new Response("ok");
    },
  });

  return { port: server.port as number, stop: () => server.stop(true) };
}
