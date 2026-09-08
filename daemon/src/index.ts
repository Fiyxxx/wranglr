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
const BIND_HOSTNAME = process.env.WRANGLR_BIND_HOST ?? process.env.WRANGLR_HOSTNAME ?? "127.0.0.1";
const PUBLIC_HOSTNAME = process.env.WRANGLR_PUBLIC_HOST ?? process.env.WRANGLR_HOSTNAME ?? BIND_HOSTNAME;
const WS_PORT = Number(process.env.WRANGLR_WS_PORT ?? 7420);
const PUBLIC_PORT = Number(process.env.WRANGLR_PUBLIC_PORT ?? WS_PORT);
const PUBLIC_SECURE = process.env.WRANGLR_SECURE === "true";
const HOOK_PORT = Number(process.env.WRANGLR_HOOK_PORT ?? 7421);
const POLICY_CONFIG_PATH = process.env.WRANGLR_POLICY_PATH ?? join(homedir(), ".config", "wranglr", "policy.json");
const VAPID_STORE_PATH = process.env.WRANGLR_VAPID_PATH ?? join(homedir(), ".config", "wranglr", "vapid.json");
const PUSH_SUBSCRIPTIONS_PATH = process.env.WRANGLR_PUSH_SUBSCRIPTIONS_PATH ?? join(homedir(), ".config", "wranglr", "push-subscriptions.json");
const VAPID_SUBJECT = process.env.WRANGLR_VAPID_SUBJECT ?? "mailto:wranglr@example.com";
const HERDR_SOCKET_PATH = process.env.WRANGLR_HERDR_SOCKET_PATH ?? join(homedir(), ".config", "herdr", "herdr.sock");

if (!TOKEN) {
  console.error("WRANGLR_TOKEN must be set");
  process.exit(1);
}

const bus = new EventBus<ServerMessage>();
const policyConfig = loadPolicyConfig(POLICY_CONFIG_PATH);
const pushManager = new PushManager(
  loadOrCreateVapidKeys(VAPID_STORE_PATH),
  undefined,
  PUSH_SUBSCRIPTIONS_PATH,
  VAPID_SUBJECT,
);

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
const pendingApprovalMessages = new Map<string, Extract<ServerMessage, { type: "approval_request" }>>();

async function onClientMessage(msg: ClientMessage): Promise<void> {
  if (msg.type === "prompt") {
    const session = latestSessions.find((s) => s.cwd === msg.worktreePath);
    if (!session) {
      bus.publish({
        type: "prompt_result",
        id: msg.id,
        worktreePath: msg.worktreePath,
        accepted: false,
        error: "No active Herdr session was found for this worktree.",
      });
      return;
    }
    try {
      await herdrAdapter.sendPrompt(session.paneId, msg.text);
      bus.publish({
        type: "prompt_result",
        id: msg.id,
        worktreePath: msg.worktreePath,
        accepted: true,
        error: null,
      });
    } catch (error) {
      bus.publish({
        type: "prompt_result",
        id: msg.id,
        worktreePath: msg.worktreePath,
        accepted: false,
        error: error instanceof Error ? error.message : "Herdr rejected the prompt.",
      });
    }
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
    const approvalMessage = {
      type: "approval_request",
      id,
      worktreePath,
      tool,
      input,
      risk: assessRisk(tool),
    } satisfies Extract<ServerMessage, { type: "approval_request" }>;
    const approvalPromise = approvalRegistry.request(id, 120_000);
    pendingApprovalMessages.set(id, approvalMessage);
    bus.publish(approvalMessage);
    void pushManager
      .notifyAll({ title: "Wranglr", body: `${tool} awaiting approval in ${worktreePath}` })
      .catch((error) => console.error("Failed to send push notification", error));

    const approvalDecision = await approvalPromise;
    pendingApprovalMessages.delete(id);
    bus.publish({
      type: "approval_resolved",
      id,
      decision: approvalDecision,
    });
    if (approvalDecision === "approve") {
      return { decision: "allow", reason: "Approved via Wranglr" };
    }
    if (approvalDecision === "reject") {
      return { decision: "deny", reason: "Rejected via Wranglr" };
    }
    return { decision: "deny", reason: "Denied (no response within 120s)" };
  },
});

startWsServer({
  token: TOKEN,
  hostname: BIND_HOSTNAME,
  port: WS_PORT,
  bus,
  onClientMessage,
  getSnapshot: () => [sessionsToWorktreeStatus(latestSessions), ...pendingApprovalMessages.values()],
  onPushSubscribe: (sub) => pushManager.addSubscription(sub),
  vapidPublicKey: pushManager.vapidPublicKey,
});

console.log(`wranglr daemon listening: ws=${BIND_HOSTNAME}:${WS_PORT} hooks=127.0.0.1:${HOOK_PORT}`);
console.log("Scan to pair the Wranglr PWA:");
qrcode.generate(buildPairingPayload(PUBLIC_HOSTNAME, PUBLIC_PORT, TOKEN, PUBLIC_SECURE), { small: true });
