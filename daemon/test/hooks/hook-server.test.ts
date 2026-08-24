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

  test("invokes onPreToolUse for a PreToolUse payload", async () => {
    const bus = new EventBus<ServerMessage>();
    const received: ServerMessage[] = [];
    const preToolCalls: unknown[] = [];
    bus.subscribe((m) => received.push(m));
    server = startHookServer({
      port: 0,
      bus,
      onPreToolUse: (event) => preToolCalls.push(event),
    });

    await fetch(`http://127.0.0.1:${server.port}/hook`, {
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
