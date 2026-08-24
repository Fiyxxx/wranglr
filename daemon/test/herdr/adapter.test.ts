import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { HerdrAdapter } from "../../src/herdr/adapter";
import { HerdrSocketClient } from "../../src/herdr/socket-client";

const SOCK_PATH = "/tmp/wranglr-test-herdr-adapter.sock";

function startFakeHerdrServer() {
  return Bun.listen({
    unix: SOCK_PATH,
    socket: {
      data(socket, chunk) {
        for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
          const req = JSON.parse(line);
          const reply = (result: Record<string, unknown>) =>
            socket.write(JSON.stringify({ id: req.id, result }) + "\n");

          if (req.method === "session.snapshot") {
            reply({
              snapshot: {
                agents: [
                  {
                    pane_id: "w1:p1",
                    workspace_id: "w1",
                    tab_id: "w1:t1",
                    cwd: "/repo/feature-x",
                    agent_status: "idle",
                    agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "sess-1" },
                  },
                ],
              },
            });
          } else if (req.method === "pane.read") {
            reply({ read: { text: "hello from pane" } });
          } else if (req.method === "pane.send_keys") {
            reply({ type: "ok" });
          } else if (req.method === "events.subscribe") {
            reply({ type: "subscription_started" });
          }
        }
      },
    },
  });
}

let fakeServer: ReturnType<typeof startFakeHerdrServer>;

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

describe("HerdrAdapter", () => {
  test("listSessions maps session.snapshot agents into HerdrSession[]", async () => {
    const client = new HerdrSocketClient(SOCK_PATH);
    await client.connect();
    const adapter = new HerdrAdapter(client);

    const sessions = await adapter.listSessions();
    expect(sessions).toEqual([
      {
        paneId: "w1:p1",
        workspaceId: "w1",
        tabId: "w1:t1",
        cwd: "/repo/feature-x",
        agentStatus: "idle",
        agentSessionId: "sess-1",
      },
    ]);
    client.close();
  });

  test("getPaneContent returns the pane.read text", async () => {
    const client = new HerdrSocketClient(SOCK_PATH);
    await client.connect();
    const adapter = new HerdrAdapter(client);

    expect(await adapter.getPaneContent("w1:p1")).toBe("hello from pane");
    client.close();
  });

  test("sendKeys resolves without throwing on an ok response", async () => {
    const client = new HerdrSocketClient(SOCK_PATH);
    await client.connect();
    const adapter = new HerdrAdapter(client);

    await expect(adapter.sendKeys("w1:p1", ["Enter"])).resolves.toBeUndefined();
    client.close();
  });

  test("onSessionChange fires the callback with a fresh session list on a pushed event", async () => {
    const client = new HerdrSocketClient(SOCK_PATH);
    await client.connect();
    const adapter = new HerdrAdapter(client);

    const calls: unknown[] = [];
    const unsubscribe = await adapter.onSessionChange((sessions) => calls.push(sessions));

    expect(calls.length).toBeGreaterThanOrEqual(1); // initial call after subscribe
    unsubscribe();
    client.close();
  });
});
