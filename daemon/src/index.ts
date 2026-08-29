import type { ServerMessage, ClientMessage } from "@wranglr/protocol";
import { EventBus } from "./event-bus";
import { HerdrSocketClient } from "./herdr/socket-client";
import { HerdrAdapter, type HerdrSession } from "./herdr/adapter";
import { startWsServer } from "./ws-server";
import { startHookServer } from "./hooks/hook-server";
import { decide, loadPolicyConfig } from "./policy/policy-engine";
import { loadOrCreateVapidKeys, PushManager } from "./push/web-push";
import { ApprovalRegistry } from "./approvals/approval-registry";
import { assessRisk } from "./approvals/risk";
import { homedir } from "node:os";
import { join } from "node:path";
import qrcode from "qrcode-terminal";
import { buildPairingPayload } from "./pairing/pairing-payload";

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
const herdrAdapter = new HerdrAdapter(herdrClient);
await herdrAdapter.onSessionChange((sessions) => {
  latestSessions = sessions;
  bus.publish(sessionsToWorktreeStatus(sessions));
});

const approvalRegistry = new ApprovalRegistry();

function onClientMessage(msg: ClientMessage): void {
  if (msg.type === "prompt") {
    const session = latestSessions.find((s) => s.cwd === msg.worktreePath);
    if (session) void herdrAdapter.sendKeys(session.paneId, [msg.text, "Enter"]);
  } else if (msg.type === "approval_response") {
    approvalRegistry.respond(msg.id, msg.decision);
  }
}

startHookServer({
  port: HOOK_PORT,
  bus,
  onPreToolUse: async ({ worktreePath, tool, input }) => {
    const policyDecision = decide(policyConfig, worktreePath, tool);
    if (policyDecision === "allow") {
      return { decision: "allow", reason: "Auto-allowed by policy" };
    }
    if (policyDecision === "block") {
      return { decision: "deny", reason: "Blocked by policy" };
    }

    const id = crypto.randomUUID();
    bus.publish({
      type: "approval_request",
      id,
      worktreePath,
      tool,
      input,
      risk: assessRisk(tool),
    });
    void pushManager.notifyAll({ title: "Wranglr", body: `${tool} awaiting approval in ${worktreePath}` });

    const approvalDecision = await approvalRegistry.request(id, 120_000);
    return approvalDecision === "approve"
      ? { decision: "allow", reason: "Approved via Wranglr" }
      : { decision: "deny", reason: "Denied (no response within 120s)" };
  },
});

startWsServer({
  token: TOKEN,
  hostname: TAILSCALE_HOSTNAME,
  port: WS_PORT,
  bus,
  onClientMessage,
  getSnapshot: () => [sessionsToWorktreeStatus(latestSessions)],
  onPushSubscribe: (sub) => pushManager.addSubscription(sub),
  vapidPublicKey: pushManager.vapidPublicKey,
});

console.log(`wranglr daemon listening: ws=${TAILSCALE_HOSTNAME}:${WS_PORT} hooks=127.0.0.1:${HOOK_PORT}`);
console.log("Scan to pair the Wranglr PWA:");
qrcode.generate(buildPairingPayload(TAILSCALE_HOSTNAME, WS_PORT, TOKEN), { small: true });
