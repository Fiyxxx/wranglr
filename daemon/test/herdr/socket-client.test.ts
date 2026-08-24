import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { HerdrSocketClient } from "../../src/herdr/socket-client";

const SOCK_PATH = "/tmp/wranglr-test-herdr.sock";

let fakeServer: ReturnType<typeof Bun.listen<undefined>>;

function startFakeHerdrServer() {
  return Bun.listen({
    unix: SOCK_PATH,
    socket: {
      data(socket, chunk) {
        const lines = chunk.toString("utf8").split("\n").filter(Boolean);
        for (const line of lines) {
          const req = JSON.parse(line);

          if (req.method === "events.subscribe") {
            // Keep connection open for subscription
            socket.write(
              JSON.stringify({ id: req.id, result: { type: "subscription_started" } }) + "\n",
            );
            // Push an event after a short delay
            setTimeout(() => {
              socket.write(
                JSON.stringify({
                  event: "pane_created",
                  data: { type: "pane_created", pane: { pane_id: "w1:p1" } },
                }) + "\n",
              );
            }, 20);
          } else if (req.method === "ping") {
            // Send response and close connection
            socket.write(JSON.stringify({ id: req.id, result: { type: "pong" } }) + "\n");
            socket.end();
          } else if (req.method === "boom") {
            // Send error response and close connection
            socket.write(
              JSON.stringify({ id: req.id, error: { code: "invalid_request", message: "boom" } }) +
                "\n",
            );
            socket.end();
          } else if (req.method === "session.snapshot") {
            // Send response and close connection
            socket.write(
              JSON.stringify({
                id: req.id,
                result: { sessions: { "session-1": { id: "session-1", name: "Main" } } },
              }) + "\n",
            );
            socket.end();
          }
        }
      },
    },
  });
}

beforeEach(() => {
  try {
    unlinkSync(SOCK_PATH);
  } catch {}
  fakeServer = startFakeHerdrServer();
});

afterEach(() => {
  fakeServer.stop(true);
  try {
    unlinkSync(SOCK_PATH);
  } catch {}
});

describe("HerdrSocketClient", () => {
  test("request() opens connection, sends request, reads response, closes cleanly", async () => {
    const client = new HerdrSocketClient(SOCK_PATH);
    const result = await client.request("ping", {});
    expect(result).toEqual({ type: "pong" });
  });

  test("two sequential request() calls both succeed with their own connections", async () => {
    const client = new HerdrSocketClient(SOCK_PATH);

    // First request
    const result1 = await client.request("ping", {});
    expect(result1).toEqual({ type: "pong" });

    // Second request on same client instance (new connection internally)
    const result2 = await client.request("session.snapshot", {});
    expect(result2).toEqual({ sessions: { "session-1": { id: "session-1", name: "Main" } } });
  });

  test("request() with error response rejects the promise", async () => {
    const client = new HerdrSocketClient(SOCK_PATH);
    await expect(client.request("boom", {})).rejects.toThrow("boom");
  });

  test("partial JSON line buffered across multiple data() callbacks resolves correctly", async () => {
    const client = new HerdrSocketClient(SOCK_PATH);

    const fullResponse = JSON.stringify({ id: "1", result: { type: "pong" } }) + "\n";
    const splitPoint = Math.floor(fullResponse.length / 2);

    // Temporarily replace server with one that sends split response
    fakeServer.stop(true);
    fakeServer = Bun.listen({
      unix: SOCK_PATH,
      socket: {
        data(socket, chunk) {
          const lines = chunk.toString("utf8").split("\n").filter(Boolean);
          for (const line of lines) {
            const req = JSON.parse(line);
            if (req.method === "ping") {
              const part1 = fullResponse.slice(0, splitPoint);
              const part2 = fullResponse.slice(splitPoint);
              socket.write(part1);
              setTimeout(() => {
                socket.write(part2);
                socket.end();
              }, 5);
            }
          }
        },
      },
    });

    const result = await client.request("ping", {});
    expect(result).toEqual({ type: "pong" });
  });

  test("subscribe() gets ack and receives pushed events via callback", async () => {
    const client = new HerdrSocketClient(SOCK_PATH);
    const events: Array<{ event: string; data: unknown }> = [];

    const unsubscribe = await client.subscribe(
      [{ type: "pane.created" }],
      (event, data) => events.push({ event, data }),
    );

    // Wait for event to arrive
    await new Promise((r) => setTimeout(r, 100));

    expect(events).toEqual([
      { event: "pane_created", data: { type: "pane_created", pane: { pane_id: "w1:p1" } } },
    ]);

    unsubscribe();
  });

  test("subscribe() with error response rejects the returned promise", async () => {
    fakeServer.stop(true);
    fakeServer = Bun.listen({
      unix: SOCK_PATH,
      socket: {
        data(socket, chunk) {
          const lines = chunk.toString("utf8").split("\n").filter(Boolean);
          for (const line of lines) {
            const req = JSON.parse(line);
            if (req.method === "events.subscribe") {
              socket.write(
                JSON.stringify({
                  id: req.id,
                  error: { code: "invalid_subscriptions", message: "invalid subscription" },
                }) + "\n",
              );
              socket.end();
            }
          }
        },
      },
    });

    const client = new HerdrSocketClient(SOCK_PATH);
    await expect(
      client.subscribe([{ type: "pane.created" }], () => {}),
    ).rejects.toThrow("invalid subscription");
  });

  test("subscribe() unsubscribe() closes connection and second call is no-op", async () => {
    const client = new HerdrSocketClient(SOCK_PATH);
    const events: Array<{ event: string; data: unknown }> = [];

    const unsubscribe = await client.subscribe(
      [{ type: "pane.created" }],
      (event, data) => events.push({ event, data }),
    );

    // Wait a bit then unsubscribe
    await new Promise((r) => setTimeout(r, 30));

    const eventCountBefore = events.length;

    // First unsubscribe should work
    unsubscribe();

    // Second unsubscribe should be no-op (not throw)
    unsubscribe();

    expect(eventCountBefore).toBeGreaterThanOrEqual(1);
  });

  test("multiple concurrent request() calls each get their own connection and response", async () => {
    const client = new HerdrSocketClient(SOCK_PATH);

    const prom1 = client.request("ping", {});
    const prom2 = client.request("session.snapshot", {});

    const [result1, result2] = await Promise.all([prom1, prom2]);

    expect(result1).toEqual({ type: "pong" });
    expect(result2).toEqual({ sessions: { "session-1": { id: "session-1", name: "Main" } } });
  });
});
