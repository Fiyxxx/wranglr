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
  return [
    { type: "worktree_status", worktrees: [] },
    { type: "worktree_status", worktrees: ["wt1"] },
  ];
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
      onPushSubscribe: () => {},
      vapidPublicKey: "test-public-key",
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
      onPushSubscribe: () => {},
      vapidPublicKey: "test-public-key",
    });

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}?token=correct-token`);
    const snapshot = snapshotMessages();
    const messages: ServerMessage[] = [];
    await new Promise<void>((resolve) => {
      let count = 0;
      ws.addEventListener("message", (e) => {
        messages.push(JSON.parse(e.data as string));
        count++;
        if (count === snapshot.length) resolve();
      });
    });
    expect(messages).toEqual(snapshot);
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
      onPushSubscribe: () => {},
      vapidPublicKey: "test-public-key",
    });

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}?token=correct-token`);
    await new Promise((resolve) => ws.addEventListener("open", resolve));
    const snapshot = snapshotMessages();
    let count = 0;
    await new Promise<void>((resolve) => {
      ws.addEventListener("message", () => {
        count++;
        if (count === snapshot.length) resolve();
      });
    }); // consume all snapshot messages

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
      onPushSubscribe: () => {},
      vapidPublicKey: "test-public-key",
    });

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}?token=correct-token`);
    await new Promise((resolve) => ws.addEventListener("open", resolve));
    const snapshot = snapshotMessages();
    let count = 0;
    await new Promise<void>((resolve) => {
      ws.addEventListener("message", () => {
        count++;
        if (count === snapshot.length) resolve();
      });
    }); // consume all snapshot messages

    ws.send(JSON.stringify({ type: "approval_response", id: "req-1", decision: "approve" }));
    await new Promise((r) => setTimeout(r, 20));

    expect(received).toEqual([{ type: "approval_response", id: "req-1", decision: "approve" }]);
    ws.close();
  });

  test("sends the full snapshot again on reconnect after the first connection closes", async () => {
    const bus = new EventBus<ServerMessage>();
    server = startWsServer({
      token: "correct-token",
      hostname: "127.0.0.1",
      port: 0,
      bus,
      onClientMessage: () => {},
      getSnapshot: snapshotMessages,
      onPushSubscribe: () => {},
      vapidPublicKey: "test-public-key",
    });

    // First connection
    const ws1 = new WebSocket(`ws://127.0.0.1:${server.port}?token=correct-token`);
    const snapshot = snapshotMessages();
    const firstMessages: ServerMessage[] = [];
    await new Promise<void>((resolve) => {
      let count = 0;
      ws1.addEventListener("message", (e) => {
        firstMessages.push(JSON.parse(e.data as string));
        count++;
        if (count === snapshot.length) resolve();
      });
    });
    expect(firstMessages).toEqual(snapshot);
    ws1.close();
    await new Promise((r) => setTimeout(r, 20)); // ensure close is processed

    // Second connection to same server
    const ws2 = new WebSocket(`ws://127.0.0.1:${server.port}?token=correct-token`);
    const secondMessages: ServerMessage[] = [];
    await new Promise<void>((resolve) => {
      let count = 0;
      ws2.addEventListener("message", (e) => {
        secondMessages.push(JSON.parse(e.data as string));
        count++;
        if (count === snapshot.length) resolve();
      });
    });
    expect(secondMessages).toEqual(snapshot);
    ws2.close();
  });

  test("POST /push-subscribe with a valid token calls onPushSubscribe and returns 204", async () => {
    const bus = new EventBus<ServerMessage>();
    const received: unknown[] = [];
    server = startWsServer({
      token: "tok",
      hostname: "127.0.0.1",
      port: 0,
      bus,
      onClientMessage: () => {},
      getSnapshot: () => [],
      onPushSubscribe: (sub) => received.push(sub),
      vapidPublicKey: "test-public-key",
    });

    const response = await fetch(`http://127.0.0.1:${server.port}/push-subscribe?token=tok`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "https://push.example/1", keys: { p256dh: "a", auth: "b" } }),
    });

    expect(response.status).toBe(204);
    expect(received).toEqual([{ endpoint: "https://push.example/1", keys: { p256dh: "a", auth: "b" } }]);
  });

  test("answers CORS preflight for a secure PWA on another port", async () => {
    const bus = new EventBus<ServerMessage>();
    server = startWsServer({
      token: "tok",
      hostname: "127.0.0.1",
      port: 0,
      bus,
      onClientMessage: () => {},
      getSnapshot: () => [],
      onPushSubscribe: () => {},
      vapidPublicKey: "test-public-key",
    });

    const response = await fetch(`http://127.0.0.1:${server.port}/push-subscribe`, { method: "OPTIONS" });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
  });

  test("POST /push-subscribe with a bad token returns 401", async () => {
    const bus = new EventBus<ServerMessage>();
    server = startWsServer({
      token: "tok",
      hostname: "127.0.0.1",
      port: 0,
      bus,
      onClientMessage: () => {},
      getSnapshot: () => [],
      onPushSubscribe: () => {},
      vapidPublicKey: "test-public-key",
    });

    const response = await fetch(`http://127.0.0.1:${server.port}/push-subscribe?token=wrong`, {
      method: "POST",
      body: JSON.stringify({ endpoint: "x", keys: { p256dh: "a", auth: "b" } }),
    });

    expect(response.status).toBe(401);
  });

  test("GET /vapid-public-key with a valid token returns the key", async () => {
    const bus = new EventBus<ServerMessage>();
    server = startWsServer({
      token: "tok",
      hostname: "127.0.0.1",
      port: 0,
      bus,
      onClientMessage: () => {},
      getSnapshot: () => [],
      onPushSubscribe: () => {},
      vapidPublicKey: "test-public-key",
    });

    const response = await fetch(`http://127.0.0.1:${server.port}/vapid-public-key?token=tok`);

    expect(await response.json()).toEqual({ publicKey: "test-public-key" });
  });

  test("POST /push-subscribe with malformed JSON returns 400", async () => {
    const bus = new EventBus<ServerMessage>();
    server = startWsServer({
      token: "tok",
      hostname: "127.0.0.1",
      port: 0,
      bus,
      onClientMessage: () => {},
      getSnapshot: () => [],
      onPushSubscribe: () => {},
      vapidPublicKey: "test-public-key",
    });

    const response = await fetch(`http://127.0.0.1:${server.port}/push-subscribe?token=tok`, {
      method: "POST",
      body: "not valid json",
    });

    expect(response.status).toBe(400);
  });

  test("GET /vapid-public-key with a bad token returns 401", async () => {
    const bus = new EventBus<ServerMessage>();
    server = startWsServer({
      token: "tok",
      hostname: "127.0.0.1",
      port: 0,
      bus,
      onClientMessage: () => {},
      getSnapshot: () => [],
      onPushSubscribe: () => {},
      vapidPublicKey: "test-public-key",
    });

    const response = await fetch(`http://127.0.0.1:${server.port}/vapid-public-key?token=wrong`);

    expect(response.status).toBe(401);
  });
});
