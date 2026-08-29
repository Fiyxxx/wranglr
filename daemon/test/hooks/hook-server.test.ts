import { afterEach, describe, expect, test } from "bun:test";
import { EventBus } from "../../src/event-bus";
import { startHookServer } from "../../src/hooks/hook-server";
import type { ServerMessage } from "@wranglr/protocol";

let server: ReturnType<typeof startHookServer> | undefined;

afterEach(() => {
  server?.stop();
  server = undefined;
});

describe("hook-server", () => {
  test("publishes a hook_event message for a PostToolUse payload", async () => {
    const bus = new EventBus<ServerMessage>();
    const received: ServerMessage[] = [];
    bus.subscribe((m) => received.push(m));
    server = startHookServer({ port: 0, bus });

    await fetch(`http://127.0.0.1:${server.port}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hook_event_name: "PostToolUse",
        cwd: "/repo/feature-x",
        tool_name: "Edit",
        tool_input: { file_path: "/repo/feature-x/a.ts" },
        tool_response: { success: true },
      }),
    });

    expect(received).toEqual([
      {
        type: "hook_event",
        hook: "PostToolUse",
        worktreePath: "/repo/feature-x",
        tool: "Edit",
        input: { file_path: "/repo/feature-x/a.ts" },
        output: { success: true },
      },
    ]);
  });

  test("awaits onPreToolUse and returns its decision as hookSpecificOutput JSON", async () => {
    const bus = new EventBus<ServerMessage>();
    const received: ServerMessage[] = [];
    const preToolCalls: unknown[] = [];
    bus.subscribe((m) => received.push(m));
    server = startHookServer({
      port: 0,
      bus,
      onPreToolUse: async (event) => {
        preToolCalls.push(event);
        return { decision: "deny", reason: "test denial" };
      },
    });

    const response = await fetch(`http://127.0.0.1:${server.port}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hook_event_name: "PreToolUse",
        cwd: "/repo/feature-x",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      }),
    });

    expect(preToolCalls).toEqual([
      { worktreePath: "/repo/feature-x", tool: "Bash", input: { command: "ls" } },
    ]);
    expect(await response.json()).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "test denial",
      },
    });
    expect(received).toEqual([
      {
        type: "hook_event",
        hook: "PreToolUse",
        worktreePath: "/repo/feature-x",
        tool: "Bash",
        input: { command: "ls" },
        output: null,
      },
    ]);
  });

  test("PreToolUse with no onPreToolUse configured still returns ok", async () => {
    const bus = new EventBus<ServerMessage>();
    server = startHookServer({ port: 0, bus });

    const response = await fetch(`http://127.0.0.1:${server.port}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hook_event_name: "PreToolUse",
        cwd: "/repo/feature-x",
        tool_name: "Read",
        tool_input: {},
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  test("returns 400 for a malformed payload", async () => {
    const bus = new EventBus<ServerMessage>();
    const received: ServerMessage[] = [];
    bus.subscribe((m) => received.push(m));
    server = startHookServer({ port: 0, bus });

    const response = await fetch(`http://127.0.0.1:${server.port}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonsense: true }),
    });

    expect(response.status).toBe(400);
    expect(received).toEqual([]);
  });
});
