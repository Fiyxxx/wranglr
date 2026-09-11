import type { HerdrSocketClient } from "./socket-client";

export interface HerdrSession {
  paneId: string;
  workspaceId: string;
  tabId: string;
  cwd: string;
  agentStatus: "idle" | "working" | "blocked" | "done" | "unknown";
  agentSessionId: string | null;
}

export interface HerdrPaneSnapshot {
  text: string;
  revision: number;
  truncated: boolean;
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

  async getPaneSnapshot(paneId: string, lines = 10_000): Promise<HerdrPaneSnapshot> {
    const result = await this.client.request<{
      read: { text: string; revision: number; truncated: boolean };
    }>("pane.read", {
      pane_id: paneId,
      source: "recent",
      format: "ansi",
      strip_ansi: false,
      lines,
    });
    return {
      text: result.read.text,
      revision: result.read.revision,
      truncated: result.read.truncated,
    };
  }

  async sendKeys(paneId: string, keys: string[]): Promise<void> {
    await this.client.request("pane.send_keys", { pane_id: paneId, keys });
  }

  async sendInput(paneId: string, input: { text?: string; keys?: string[] }): Promise<void> {
    await this.client.request("pane.send_input", { pane_id: paneId, ...input });
  }

  async sendPrompt(paneId: string, text: string): Promise<void> {
    await this.client.request("agent.prompt", { target: paneId, text });
  }

  async onSessionChange(
    callback: (sessions: HerdrSession[]) => void,
    onPaneOutput?: (paneId: string, revision: number | null) => void,
  ): Promise<() => void> {
    let currentUnsubscribe: (() => void) | null = null;
    let lastPaneIdSet = "";

    const resubscribe = async (): Promise<void> => {
      const sessions = await this.listSessions();
      const paneIds = sessions.map((s) => s.paneId).sort();
      const paneIdSetKey = paneIds.join(",");

      // Avoid redundant subscription if pane set hasn't changed (prevents infinite loop from backfill replay)
      if (paneIdSetKey === lastPaneIdSet && currentUnsubscribe) {
        return;
      }
      lastPaneIdSet = paneIdSetKey;

      const subscriptions = [
        { type: "pane.created" },
        { type: "pane.closed" },
        { type: "pane.updated" },
        ...paneIds.map((pane_id) => ({ type: "pane.agent_status_changed", pane_id })),
      ];

      const newUnsubscribe = await this.client.subscribe(subscriptions, (event, data) => {
        if (
          event === "pane_created" ||
          event === "pane_closed" ||
          event === "pane_agent_status_changed"
        ) {
          void resubscribe().then(async () => callback(await this.listSessions()));
        } else if (event === "pane_output_changed") {
          const paneId = typeof data.pane_id === "string" ? data.pane_id : null;
          const revision = typeof data.revision === "number" ? data.revision : null;
          if (paneId) onPaneOutput?.(paneId, revision);
        }
      });

      currentUnsubscribe?.();
      currentUnsubscribe = newUnsubscribe;
    };

    await resubscribe();
    callback(await this.listSessions());

    return () => currentUnsubscribe?.();
  }
}
