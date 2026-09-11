import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { HerdrAdapter } from "../../src/herdr/adapter";
import { HerdrSocketClient } from "../../src/herdr/socket-client";

const SOCK_PATH = "/tmp/wranglr-test-herdr-adapter.sock";

interface FakeServerState {
  snapshotCallCount: number;
  subscriptionCalls: Array<{ subscriptions: Array<{ type: string; pane_id?: string }> }>;
  expandSnapshotAfter: number;
  subscribedSocket: ReturnType<typeof Bun.connect> extends Promise<infer S> ? S | null : never;
  prompts: Array<{ target: string; text: string }>;
  inputs: Array<{ pane_id: string; text?: string; keys?: string[] }>;
}

function startFakeHerdrServer(state: FakeServerState) {
  return Bun.listen({
    unix: SOCK_PATH,
    socket: {
      data(socket, chunk) {
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
            // One-shot: close after response
            socket.end();
          } else if (req.method === "pane.read") {
            reply({ read: { text: "\u001b[36mhello from pane\u001b[0m", revision: 12, truncated: false } });
            socket.end();
          } else if (req.method === "pane.send_keys") {
            reply({ type: "ok" });
            socket.end();
          } else if (req.method === "pane.send_input") {
            state.inputs.push(req.params);
            reply({ type: "ok" });
            socket.end();
          } else if (req.method === "agent.prompt") {
            state.prompts.push(req.params);
            reply({ type: "ok" });
            socket.end();
          } else if (req.method === "events.subscribe") {
            state.subscriptionCalls.push(req.params);
            reply({ type: "subscription_started" });
            // Keep connection open to push events (don't call socket.end())
            state.subscribedSocket = socket;
          } else if (req.method === "test.emit_event") {
            // Special test helper: emit an event on the subscription connection
            if (state.subscribedSocket) {
              state.subscribedSocket.write(JSON.stringify({ event: req.params.event, data: req.params.data ?? {} }) + "\n");
            }
            reply({ type: "ok" });
            socket.end();
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
  serverState = {
    snapshotCallCount: 0,
    subscriptionCalls: [],
    expandSnapshotAfter: Infinity,
    subscribedSocket: null,
    prompts: [],
    inputs: [],
  };
  fakeServer = startFakeHerdrServer(serverState);
});

afterEach(() => {
  if (serverState.subscribedSocket) {
    serverState.subscribedSocket.end();
  }
  fakeServer.stop(true);
  try {
    unlinkSync(SOCK_PATH);
  } catch {}
});

describe("HerdrAdapter", () => {
  test("listSessions maps session.snapshot agents into HerdrSession[]", async () => {
    const client = new HerdrSocketClient(SOCK_PATH);
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
  });

  test("getPaneContent returns the pane.read text", async () => {
    const client = new HerdrSocketClient(SOCK_PATH);
    const adapter = new HerdrAdapter(client);

    expect(await adapter.getPaneContent("w1:p1")).toBe("\u001b[36mhello from pane\u001b[0m");
  });

  test("getPaneSnapshot keeps ANSI and revision metadata", async () => {
    const client = new HerdrSocketClient(SOCK_PATH);
    const adapter = new HerdrAdapter(client);

    expect(await adapter.getPaneSnapshot("w1:p1")).toEqual({
      text: "\u001b[36mhello from pane\u001b[0m",
      revision: 12,
      truncated: false,
    });
  });

  test("sendKeys resolves without throwing on an ok response", async () => {
    const client = new HerdrSocketClient(SOCK_PATH);
    const adapter = new HerdrAdapter(client);

    await expect(adapter.sendKeys("w1:p1", ["Enter"])).resolves.toBeUndefined();
  });

  test("sendPrompt uses Herdr's agent.prompt API", async () => {
    const client = new HerdrSocketClient(SOCK_PATH);
    const adapter = new HerdrAdapter(client);

    await adapter.sendPrompt("w1:p1", "run the tests");

    expect(serverState.prompts).toEqual([{ target: "w1:p1", text: "run the tests" }]);
  });

  test("sendInput forwards raw terminal text and logical keys", async () => {
    const client = new HerdrSocketClient(SOCK_PATH);
    const adapter = new HerdrAdapter(client);

    await adapter.sendInput("w1:p1", { text: "ls", keys: ["enter"] });
    expect(serverState.inputs).toEqual([{ pane_id: "w1:p1", text: "ls", keys: ["enter"] }]);
  });

  test("onSessionChange fires the callback with a fresh session list on a pushed event", async () => {
    const client = new HerdrSocketClient(SOCK_PATH);
    const adapter = new HerdrAdapter(client);

    const calls: unknown[] = [];
    const unsubscribe = await adapter.onSessionChange((sessions) => calls.push(sessions));

    expect(calls.length).toBeGreaterThanOrEqual(1); // initial call after subscribe
    unsubscribe();
  });

  test("onSessionChange re-subscribes with new pane agent_status_changed when pane appears", async () => {
    const client = new HerdrSocketClient(SOCK_PATH);
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

    // Now enable the snapshot expansion (after the initial call)
    serverState.expandSnapshotAfter = serverState.snapshotCallCount;

    // Emit a pane_created event to trigger re-subscription
    await client.request("test.emit_event", { event: "pane_created" });

    // Wait for callback to fire with updated list
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
    expect(secondSub).toContainEqual({ type: "pane.agent_status_changed", pane_id: "w1:p1" });
    expect(secondSub).toContainEqual({ type: "pane.agent_status_changed", pane_id: "w1:p2" });

    unsubscribe();
  });

  test("onSessionChange prevents infinite loop from backfill replay of same pane set", async () => {
    const client = new HerdrSocketClient(SOCK_PATH);
    const adapter = new HerdrAdapter(client);

    const calls: unknown[] = [];
    const unsubscribe = await adapter.onSessionChange((sessions) => calls.push(sessions));

    // Verify initial subscription
    expect(serverState.subscriptionCalls.length).toBe(1);
    const subscriptionCountAfterInit = serverState.subscriptionCalls.length;

    // Emit multiple pane_created events for the SAME pane (simulating backfill replay)
    // Each subscription to pane.created generates a synthetic event for each existing pane
    await client.request("test.emit_event", { event: "pane_created" });
    await new Promise((r) => setTimeout(r, 30));
    await client.request("test.emit_event", { event: "pane_created" });
    await new Promise((r) => setTimeout(r, 30));
    await client.request("test.emit_event", { event: "pane_created" });
    await new Promise((r) => setTimeout(r, 30));

    // The callback should fire for each event, but NO new subscriptions should be opened
    // (because the pane set hasn't changed, only the same pane_created event fired multiple times)
    expect(serverState.subscriptionCalls.length).toBe(subscriptionCountAfterInit);

    unsubscribe();
  });

  test("onSessionChange routes output events without refreshing the session list", async () => {
    const client = new HerdrSocketClient(SOCK_PATH);
    const adapter = new HerdrAdapter(client);

    const calls: unknown[] = [];
    const outputCalls: Array<{ paneId: string; revision: number | null }> = [];
    const unsubscribe = await adapter.onSessionChange(
      (sessions) => calls.push(sessions),
      (paneId, revision) => outputCalls.push({ paneId, revision }),
    );

    // Verify initial callback
    expect(calls.length).toBe(1);

    // Verify first (and only) subscription was made
    const subscriptionCountAfterInit = serverState.subscriptionCalls.length;
    expect(subscriptionCountAfterInit).toBe(1);

    await client.request("test.emit_event", {
      event: "pane_output_changed",
      data: { pane_id: "w1:p1", revision: 99 },
    });
    await new Promise((r) => setTimeout(r, 30));

    // No new callbacks should have fired, and no new subscriptions should have been opened
    expect(calls.length).toBe(1); // still just the initial call
    expect(serverState.subscriptionCalls.length).toBe(subscriptionCountAfterInit); // still just one

    // Output subscriptions do not trigger expensive session snapshot refreshes.
    const sub = serverState.subscriptionCalls[0].subscriptions as Array<{ type: string; pane_id?: string }>;
    expect(sub).toContainEqual({ type: "pane.created" });
    expect(sub).toContainEqual({ type: "pane.closed" });
    expect(sub).toContainEqual({ type: "pane.updated" });
    expect(sub).toContainEqual({ type: "pane.agent_status_changed", pane_id: "w1:p1" });
    expect(outputCalls).toEqual([{ paneId: "w1:p1", revision: 99 }]);

    unsubscribe();
  });
});
