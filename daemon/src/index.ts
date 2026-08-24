import type { ServerMessage, ClientMessage } from "@wranglr/protocol";
import { EventBus } from "./event-bus";
import { HerdrSocketClient } from "./herdr/socket-client";
import { HerdrAdapter, type HerdrSession } from "./herdr/adapter";
import { startWsServer } from "./ws-server";
import { startHookServer } from "./hooks/hook-server";
import { decide, loadPolicyConfig } from "./policy/policy-engine";
import { loadOrCreateVapidKeys, PushManager } from "./push/web-push";
import { homedir } from "node:os";
import { join } from "node:path";

const TOKEN = process.env.WRANGLR_TOKEN;
const TAILSCALE_HOSTNAME = process.env.WRANGLR_HOSTNAME ?? "127.0.0.1";
const WS_PORT = Number(process.env.WRANGLR_WS_PORT ?? 7420);
const HOOK_PORT = Number(process.env.WRANGLR_HOOK_PORT ?? 7421);
const POLICY_CONFIG_PATH = process.env.WRANGLR_POLICY_PATH ?? join(homedir(), ".config", "wranglr", "policy.json");
const VAPID_STORE_PATH = join(homedir(), ".config", "wranglr", "vapid.json");
const HERDR_SOCKET_PATH = join(homedir(), ".config", "herdr", "herdr.sock");

if (!TOKEN) {
  console.error("WRANGLR_TOKEN must be set");
  process.exit(1);
}

const bus = new EventBus<ServerMessage>();
const policyConfig = loadPolicyConfig(POLICY_CONFIG_PATH);
const pushManager = new PushManager(loadOrCreateVapidKeys(VAPID_STORE_PATH));

let latestSessions: HerdrSession[] = [];

function sessionsToWorktreeStatus(sessions: HerdrSession[]): ServerMessage {
  return {
    type: "worktree_status",
    worktrees: sessions.map((s) => ({
      path: s.cwd,
      herdrPaneId: s.paneId,
      state: s.agentStatus,
    })),
  };
}

const herdrClient = new HerdrSocketClient(HERDR_SOCKET_PATH);
await herdrClient.connect();
const herdrAdapter = new HerdrAdapter(herdrClient);
await herdrAdapter.onSessionChange((sessions) => {
  latestSessions = sessions;
  bus.publish(sessionsToWorktreeStatus(sessions));
});

function onClientMessage(msg: ClientMessage): void {
  if (msg.type === "prompt") {
    const session = latestSessions.find((s) => s.cwd === msg.worktreePath);
    if (session) void herdrAdapter.sendKeys(session.paneId, [msg.text, "Enter"]);
  }
  // approval_response handling is wired up once the hook receiver tracks
  // pending approval requests keyed by id (Task 6 only publishes hook_event;
  // approval_request/response correlation is future scope, not v1).
}

startHookServer({
  port: HOOK_PORT,
  bus,
  onPreToolUse: ({ worktreePath, tool }) => {
    const decision = decide(policyConfig, worktreePath, tool);
    if (decision === "ask") {
      void pushManager.notifyAll({ title: "Wranglr", body: `${tool} awaiting approval in ${worktreePath}` });
    }
  },
});

startWsServer({
  token: TOKEN,
  hostname: TAILSCALE_HOSTNAME,
  port: WS_PORT,
  bus,
  onClientMessage,
  getSnapshot: () => [sessionsToWorktreeStatus(latestSessions)],
});

console.log(`wranglr daemon listening: ws=${TAILSCALE_HOSTNAME}:${WS_PORT} hooks=127.0.0.1:${HOOK_PORT}`);
