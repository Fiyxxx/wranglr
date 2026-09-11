/// <reference lib="dom" />
import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import DashboardPage from "./page";
import { WranglrContext, type WranglrState } from "../../lib/store";

function renderWithState(state: WranglrState) {
  render(
    <WranglrContext.Provider value={{ state, send: () => {} }}>
      <DashboardPage />
    </WranglrContext.Provider>,
  );
}

describe("DashboardPage", () => {
  test("lists each worktree with its path and state", () => {
    renderWithState({
      connectionStatus: "open",
      worktrees: [
        { path: "/repo/feature-x", herdrPaneId: "p1", state: "working" },
        { path: "/repo/feature-y", herdrPaneId: null, state: "idle" },
      ],
      hookEvents: [],
      pendingApprovals: [],
      promptResults: [],
      terminals: {},
    });

    expect(screen.getByText("/repo/feature-x")).toBeTruthy();
    expect(screen.getByText("/repo/feature-y")).toBeTruthy();
    expect(document.querySelector(".session-dot.status-working")).toBeTruthy();
    expect(document.querySelector(".session-dot.status-idle")).toBeTruthy();
  });

  test("links each worktree to its detail page keyed by encoded path", () => {
    renderWithState({
      connectionStatus: "open",
      worktrees: [{ path: "/repo/feature-x", herdrPaneId: "p1", state: "working" }],
      hookEvents: [],
      pendingApprovals: [],
      promptResults: [],
      terminals: {},
    });

    const link = screen.getByRole("link", { name: /feature-x/ });
    expect(link.getAttribute("href")).toBe(`/worktree?path=${encodeURIComponent("/repo/feature-x")}`);
  });

  test("shows a pending-approval count badge when approvals are waiting", () => {
    renderWithState({
      connectionStatus: "open",
      worktrees: [{ path: "/repo/feature-x", herdrPaneId: "p1", state: "blocked" }],
      hookEvents: [],
      pendingApprovals: [{ id: "1", worktreePath: "/repo/feature-x", tool: "Bash", input: {}, risk: "high" }],
      promptResults: [],
      terminals: {},
    });

    expect(screen.getByText("1 pending")).toBeTruthy();
  });
});
