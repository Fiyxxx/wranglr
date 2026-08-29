/// <reference lib="dom" />
import { describe, expect, test, afterEach } from "bun:test";
import { WranglrWsClient, type ConnectionStatus } from "./ws-client";
import type { ServerMessage } from "@wranglr/protocol";

let servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(() => {
  for (const s of servers) s.stop(true);
  servers = [];
});

function startFakeServer(onMessage?: (raw: string) => void) {
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined as unknown as Response;
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ type: "worktree_status", worktrees: [] }));
      },
      message(_ws, raw) {
        onMessage?.(String(raw));
      },
      close() {},
    },
  });
  servers.push(server);
  return server;
}

describe("WranglrWsClient", () => {
  test("reports connecting then open, and delivers a parsed ServerMessage", async () => {
    const server = startFakeServer();
    const statuses: ConnectionStatus[] = [];
    const messages: ServerMessage[] = [];

    const client = new WranglrWsClient(`ws://127.0.0.1:${server.port}`, {
      onMessage: (msg) => messages.push(msg),
      onStatusChange: (status) => statuses.push(status),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(statuses).toEqual(["connecting", "open"]);
    expect(messages).toEqual([{ type: "worktree_status", worktrees: [] }]);

    client.close();
  });

  test("send() serializes a ClientMessage over the socket", async () => {
    const received: string[] = [];
    const server = startFakeServer((raw) => received.push(raw));

    const client = new WranglrWsClient(`ws://127.0.0.1:${server.port}`, {
      onMessage: () => {},
      onStatusChange: () => {},
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    client.send({ type: "prompt", worktreePath: "/repo", text: "hi" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toEqual([JSON.stringify({ type: "prompt", worktreePath: "/repo", text: "hi" })]);
    client.close();
  });

  test("reports closed after close()", async () => {
    const server = startFakeServer();
    const statuses: ConnectionStatus[] = [];

    const client = new WranglrWsClient(`ws://127.0.0.1:${server.port}`, {
      onMessage: () => {},
      onStatusChange: (status) => statuses.push(status),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    client.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(statuses).toEqual(["connecting", "open", "closed"]);
  });
});
