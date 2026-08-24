import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { HerdrAdapter } from "../../src/herdr/adapter";
import { HerdrSocketClient } from "../../src/herdr/socket-client";

const SOCK_PATH = "/tmp/wranglr-test-herdr-adapter.sock";

interface FakeServerState {
  snapshotCallCount: number;
  subscriptionCalls: Array<{ subscriptions: Array<{ type: string; pane_id?: string }> }>;
  expandSnapshotAfter: number; // expand snapshot after this many calls
  socket?: ReturnType<typeof Bun.connect> extends Promise<infer S> ? S : never;
}

function startFakeHerdrServer(state: FakeServerState) {
  return Bun.listen({
    unix: SOCK_PATH,
    socket: {
      data(socket, chunk) {
        state.socket = socket;
        for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
          const req = JSON.parse(line);
          const reply = (result: Record<string, unknown>) =>
            socket.write(JSON.stringify({ id: req.id, result }) + "\n");

          if (req.method === "session.snapshot") {
            state.snapshotCallCount++;
            const agents =
              state.snapshotCallCount > state.expandSnapshotAfter
                ? [
                    {
                      pane_id: "w1:p1",
                      workspace_id: "w1",
                      tab_id: "w1:t1",
                      cwd: "/repo/feature-x",
                      agent_status: "idle",
                      agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "sess-1" },
                    },
                    {
                      pane_id: "w1:p2",
                      workspace_id: "w1",
                      tab_id: "w1:t2",
                      cwd: "/repo/feature-y",
                      agent_status: "working",
                      agent_session: null,
                    },
                  ]
                : [
                    {
                      pane_id: "w1:p1",
                      workspace_id: "w1",
                      tab_id: "w1:t1",
                      cwd: "/repo/feature-x",
                      agent_status: "idle",
                      agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "sess-1" },
                    },
                  ];
            reply({ snapshot: { agents } });
          } else if (req.method === "pane.read") {
            reply({ read: { text: "hello from pane" } });
          } else if (req.method === "pane.send_keys") {
            reply({ type: "ok" });
          } else if (req.method === "events.subscribe") {
            state.subscriptionCalls.push(req.params);
            reply({ type: "subscription_started" });
          } else if (req.method === "test.emit_event") {
            // Special test helper: emit an event to the client
            socket.write(JSON.stringify({ event: req.params.event, data: {} }) + "\n");
            reply({ type: "ok" });
          }
        }
      },
    },
  });
}

let fakeServer: ReturnType<typeof startFakeHerdrServer>;
let serverState: FakeServerState;

beforeEach(() => {
  try {
    unlinkSync(SOCK_PATH);
  } catch {}
  serverState = { snapshotCallCount: 0, subscriptionCalls: [], expandSnapshotAfter: Infinity };
  fakeServer = startFakeHerdrServer(serverState);
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

  test("onSessionChange re-subscribes with new pane agent_status_changed when pane appears", async () => {
    const client = new HerdrSocketClient(SOCK_PATH);
    await client.connect();
    const adapter = new HerdrAdapter(client);

    const calls: unknown[] = [];
    const unsubscribe = await adapter.onSessionChange((sessions) => calls.push(sessions));

    // Verify initial call with one pane
    expect(calls.length).toBe(1);
    expect((calls[0] as unknown[]).length).toBe(1);
    expect(((calls[0] as unknown[])[0] as Record<string, unknown>).paneId).toBe("w1:p1");

    // Verify first subscription was made
    expect(serverState.subscriptionCalls.length).toBe(1);
    const firstSub = serverState.subscriptionCalls[0].subscriptions as Array<{ type: string; pane_id?: string }>;
    expect(firstSub).toContainEqual({ type: "pane.created" });
    expect(firstSub).toContainEqual({ type: "pane.closed" });
    expect(firstSub).toContainEqual({ type: "pane.updated" });
    expect(firstSub).toContainEqual({ type: "pane.agent_status_changed", pane_id: "w1:p1" });

    // Now enable the snapshot expansion (after the initial 2 calls: resubscribeToKnownPanes and emit)
    serverState.expandSnapshotAfter = serverState.snapshotCallCount;

    // Emit a pane_created event to trigger re-subscription
    // (the fake server's session.snapshot will now return 2 panes on subsequent calls)
    await client.request("test.emit_event", { event: "pane_created" });

    // Wait for callback to fire with updated list
    // Using a small async delay to let the event propagate
    await new Promise((r) => setTimeout(r, 50));

    // Verify second callback fired with two panes
    expect(calls.length).toBe(2);
    const secondCallSessions = calls[1] as unknown[];
    expect(secondCallSessions.length).toBe(2);
    const paneIds = (secondCallSessions as Record<string, unknown>[]).map((s) => s.paneId);
    expect(paneIds).toContain("w1:p1");
    expect(paneIds).toContain("w1:p2");

    // Verify second subscription includes the new pane's agent_status_changed
    expect(serverState.subscriptionCalls.length).toBe(2);
    const secondSub = serverState.subscriptionCalls[1].subscriptions as Array<{ type: string; pane_id?: string }>;
    expect(secondSub).toContainEqual({ type: "pane.created" });
    expect(secondSub).toContainEqual({ type: "pane.closed" });
    expect(secondSub).toContainEqual({ type: "pane.updated" });
    expect(secondSub).toContainEqual({ type: "pane.agent_status_changed", pane_id: "w1:p1" });
    expect(secondSub).toContainEqual({ type: "pane.agent_status_changed", pane_id: "w1:p2" });

    unsubscribe();
    client.close();
  });
});
