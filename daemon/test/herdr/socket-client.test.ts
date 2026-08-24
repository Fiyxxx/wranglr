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
});
