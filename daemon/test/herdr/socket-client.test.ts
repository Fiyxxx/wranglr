import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { HerdrSocketClient } from "../../src/herdr/socket-client";

const SOCK_PATH = "/tmp/wranglr-test-herdr.sock";

let fakeServer: ReturnType<typeof Bun.listen<undefined>>;
let serverSocket: any;

function startFakeHerdrServer(customHandler?: (socket: any, chunk: Buffer) => void) {
  return Bun.listen({
    unix: SOCK_PATH,
    socket: {
      open(socket) {
        serverSocket = socket;
      },
      data(socket, chunk) {
        if (customHandler) {
          customHandler(socket, chunk);
          return;
        }
        const lines = chunk.toString("utf8").split("\n").filter(Boolean);
        for (const line of lines) {
          const req = JSON.parse(line);
          if (req.method === "ping") {
            socket.write(JSON.stringify({ id: req.id, result: { type: "pong" } }) + "\n");
          } else if (req.method === "events.subscribe") {
            socket.write(JSON.stringify({ id: req.id, result: { type: "subscription_started" } }) + "\n");
            socket.write(
              JSON.stringify({
                event: "pane_created",
                data: { type: "pane_created", pane: { pane_id: "w1:p1" } },
              }) + "\n",
            );
          } else if (req.method === "boom") {
            socket.write(
              JSON.stringify({ id: req.id, error: { code: "invalid_request", message: "boom" } }) + "\n",
            );
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
  test("sends a request and resolves with the matching result by id", async () => {
    const client = new HerdrSocketClient(SOCK_PATH);
    await client.connect();
    const result = await client.request("ping", {});
    expect(result).toEqual({ type: "pong" });
    client.close();
  });

  test("rejects the request promise on an error response", async () => {
    const client = new HerdrSocketClient(SOCK_PATH);
    await client.connect();
    await expect(client.request("boom", {})).rejects.toThrow("boom");
    client.close();
  });

  test("dispatches pushed events (no id) to onEvent listeners, not to pending requests", async () => {
    const client = new HerdrSocketClient(SOCK_PATH);
    await client.connect();
    const seen: Array<{ event: string; data: unknown }> = [];
    const unsubscribe = client.onEvent((event, data) => seen.push({ event, data }));

    const subResult = await client.request("events.subscribe", {
      subscriptions: [{ type: "pane.created" }],
    });
    expect(subResult).toEqual({ type: "subscription_started" });

    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual([
      { event: "pane_created", data: { type: "pane_created", pane: { pane_id: "w1:p1" } } },
    ]);

    unsubscribe();
    client.close();
  });

  test("handles JSON line split across multiple data() invocations", async () => {
    const fullResponse = JSON.stringify({ id: "1", result: { type: "pong" } }) + "\n";
    const splitPoint = Math.floor(fullResponse.length / 2);
    const part1 = fullResponse.slice(0, splitPoint);
    const part2 = fullResponse.slice(splitPoint);

    fakeServer.stop(true);
    fakeServer = startFakeHerdrServer((socket) => {
      setTimeout(() => {
        socket.write(part1);
        setTimeout(() => {
          socket.write(part2);
        }, 10);
      }, 10);
    });

    const client = new HerdrSocketClient(SOCK_PATH);
    await client.connect();
    const result = await client.request("ping", {});
    expect(result).toEqual({ type: "pong" });
    client.close();
  });

  test("multiple concurrent requests resolve with their own matching results", async () => {
    fakeServer.stop(true);
    fakeServer = startFakeHerdrServer((socket, chunk) => {
      const lines = chunk.toString("utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        const req = JSON.parse(line);
        if (req.method === "req_a") {
          // Reply to req_b first, then req_a (out of order)
          setTimeout(() => {
            socket.write(JSON.stringify({ id: "2", result: { data: "response_b" } }) + "\n");
          }, 5);
          setTimeout(() => {
            socket.write(JSON.stringify({ id: req.id, result: { data: "response_a" } }) + "\n");
          }, 20);
        } else if (req.method === "req_b") {
          // Don't respond yet; will respond via req_a handler
        }
      }
    });

    const client = new HerdrSocketClient(SOCK_PATH);
    await client.connect();

    const promiseA = client.request("req_a", {});
    const promiseB = client.request("req_b", {});

    const resultA = await promiseA;
    const resultB = await promiseB;

    expect(resultA).toEqual({ data: "response_a" });
    expect(resultB).toEqual({ data: "response_b" });
    client.close();
  });

  test("rejects pending requests when socket closes", async () => {
    fakeServer.stop(true);
    fakeServer = startFakeHerdrServer((socket, chunk) => {
      const lines = chunk.toString("utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        const req = JSON.parse(line);
        if (req.method === "delay") {
          // Don't respond; let socket close instead
          setTimeout(() => {
            socket.end();
          }, 20);
        }
      }
    });

    const client = new HerdrSocketClient(SOCK_PATH);
    await client.connect();

    const pendingRequest = client.request("delay", {});
    await expect(pendingRequest).rejects.toThrow("herdr socket closed");
  });

  test("request() called immediately after connect() (without await) resolves once connected", async () => {
    const client = new HerdrSocketClient(SOCK_PATH);
    const connectPromise = client.connect();

    // Call request() before connect() resolves
    const requestPromise = client.request("ping", {});

    await connectPromise;
    const result = await requestPromise;
    expect(result).toEqual({ type: "pong" });
    client.close();
  });

  test("close() called immediately after connect() (without await) succeeds once connected", async () => {
    const client = new HerdrSocketClient(SOCK_PATH);
    const connectPromise = client.connect();

    // Call close() before connect() resolves - should not throw
    const closePromise = Promise.resolve(client.close());

    await connectPromise;
    await closePromise;
    // If we get here without error, test passes
    expect(true).toBe(true);
  });
});
