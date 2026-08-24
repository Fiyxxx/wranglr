import { afterEach, describe, expect, test } from "bun:test";
import { EventBus } from "../src/event-bus";
import { startWsServer } from "../src/ws-server";
import type { ServerMessage, ClientMessage } from "@wranglr/protocol";

let server: ReturnType<typeof startWsServer> | undefined;

afterEach(() => {
  server?.stop();
  server = undefined;
});

function snapshotMessages(): ServerMessage[] {
  return [{ type: "worktree_status", worktrees: [] }];
}

describe("ws-server", () => {
  test("rejects a connection with a missing or wrong token", async () => {
    const bus = new EventBus<ServerMessage>();
    server = startWsServer({
      token: "correct-token",
      hostname: "127.0.0.1",
      port: 0,
      bus,
      onClientMessage: () => {},
      getSnapshot: snapshotMessages,
    });

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}?token=wrong-token`);
    const closeEvent = await new Promise<CloseEvent>((resolve) => {
      ws.addEventListener("close", resolve);
    });
    expect(closeEvent.type).toBe("close");
  });

  test("sends the full snapshot immediately on connect", async () => {
    const bus = new EventBus<ServerMessage>();
    server = startWsServer({
      token: "correct-token",
      hostname: "127.0.0.1",
      port: 0,
      bus,
      onClientMessage: () => {},
      getSnapshot: snapshotMessages,
    });

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}?token=correct-token`);
    const firstMessage = await new Promise<string>((resolve) => {
      ws.addEventListener("message", (e) => resolve(e.data as string));
    });
    expect(JSON.parse(firstMessage)).toEqual(snapshotMessages());
    ws.close();
  });

  test("relays a bus-published event to connected clients", async () => {
    const bus = new EventBus<ServerMessage>();
    server = startWsServer({
      token: "correct-token",
      hostname: "127.0.0.1",
      port: 0,
      bus,
      onClientMessage: () => {},
      getSnapshot: snapshotMessages,
    });

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}?token=correct-token`);
    await new Promise((resolve) => ws.addEventListener("open", resolve));
    await new Promise((resolve) => ws.addEventListener("message", resolve)); // consume snapshot

    const nextMessage = new Promise<string>((resolve) => {
      ws.addEventListener("message", (e) => resolve(e.data as string));
    });
    bus.publish({ type: "worktree_status", worktrees: [] });

    expect(JSON.parse(await nextMessage)).toEqual({ type: "worktree_status", worktrees: [] });
    ws.close();
  });

  test("parses and forwards a valid inbound client message via onClientMessage", async () => {
    const bus = new EventBus<ServerMessage>();
    const received: ClientMessage[] = [];
    server = startWsServer({
      token: "correct-token",
      hostname: "127.0.0.1",
      port: 0,
      bus,
      onClientMessage: (msg) => received.push(msg),
      getSnapshot: snapshotMessages,
    });

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}?token=correct-token`);
    await new Promise((resolve) => ws.addEventListener("open", resolve));
    await new Promise((resolve) => ws.addEventListener("message", resolve)); // consume snapshot

    ws.send(JSON.stringify({ type: "approval_response", id: "req-1", decision: "approve" }));
    await new Promise((r) => setTimeout(r, 20));

    expect(received).toEqual([{ type: "approval_response", id: "req-1", decision: "approve" }]);
    ws.close();
  });
});
