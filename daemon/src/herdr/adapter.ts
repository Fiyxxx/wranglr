import type { HerdrSocketClient } from "./socket-client";

export interface HerdrSession {
  paneId: string;
  workspaceId: string;
  tabId: string;
  cwd: string;
  agentStatus: "idle" | "working" | "blocked" | "done" | "unknown";
  agentSessionId: string | null;
}

interface SnapshotAgent {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  cwd: string;
  agent_status: HerdrSession["agentStatus"];
  agent_session?: { value: string } | null;
}

function toSession(a: SnapshotAgent): HerdrSession {
  return {
    paneId: a.pane_id,
    workspaceId: a.workspace_id,
    tabId: a.tab_id,
    cwd: a.cwd,
    agentStatus: a.agent_status,
    agentSessionId: a.agent_session?.value ?? null,
  };
}

export class HerdrAdapter {
  private client: HerdrSocketClient;
  private subscribedPaneIds = new Set<string>();

  constructor(client: HerdrSocketClient) {
    this.client = client;
  }

  async listSessions(): Promise<HerdrSession[]> {
    const result = await this.client.request<{ snapshot: { agents: SnapshotAgent[] } }>(
      "session.snapshot",
      {},
    );
    return result.snapshot.agents.map(toSession);
  }

  async getPaneContent(paneId: string, lines = 200): Promise<string> {
    const result = await this.client.request<{ read: { text: string } }>("pane.read", {
      pane_id: paneId,
      source: "recent_unwrapped",
      lines,
    });
    return result.read.text;
  }

  async sendKeys(paneId: string, keys: string[]): Promise<void> {
    await this.client.request("pane.send_keys", { pane_id: paneId, keys });
  }

  async onSessionChange(callback: (sessions: HerdrSession[]) => void): Promise<() => void> {
    const emit = async () => callback(await this.listSessions());

    const unsubscribeEvents = this.client.onEvent((event) => {
      if (
        event === "pane_created" ||
        event === "pane_closed" ||
        event === "pane_updated" ||
        event === "pane_agent_status_changed"
      ) {
        void this.resubscribeToKnownPanes().then(emit);
      }
    });

    await this.resubscribeToKnownPanes();
    await emit();

    return () => unsubscribeEvents();
  }

  private async resubscribeToKnownPanes(): Promise<void> {
    const sessions = await this.listSessions();
    const newPaneIds = sessions.map((s) => s.paneId).filter((id) => !this.subscribedPaneIds.has(id));
    if (newPaneIds.length === 0 && this.subscribedPaneIds.size > 0) return;

    for (const id of newPaneIds) this.subscribedPaneIds.add(id);

    await this.client.request("events.subscribe", {
      subscriptions: [
        { type: "pane.created" },
        { type: "pane.closed" },
        { type: "pane.updated" },
        ...[...this.subscribedPaneIds].map((pane_id) => ({
          type: "pane.agent_status_changed",
          pane_id,
        })),
      ],
    });
  }
}
