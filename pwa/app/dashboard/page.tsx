"use client";

import { useState } from "react";
import { useWranglr } from "../../lib/store";
import { loadPairing } from "../../lib/pairing";
import { clearPairing } from "../../lib/pairing";
import { registerPush } from "../../lib/push";

export default function DashboardPage() {
  const { state } = useWranglr();
  const [notificationStatus, setNotificationStatus] = useState<"idle" | "granted" | "denied" | "unsupported">("idle");

  return (
    <main className="page">
      <header className="hero compact-hero">
        <p className="eyebrow">Live agent overview</p>
        <h1>Worktrees</h1>
      </header>
      <ul className="worktree-list">
        {state.worktrees.map((worktree) => {
          const pendingCount = state.pendingApprovals.filter((a) => a.worktreePath === worktree.path).length;
          return (
            <li className="card worktree-card" key={worktree.path}>
              <a href={`/worktree?path=${encodeURIComponent(worktree.path)}`}>
                <span className="worktree-name">{worktree.path.split("/").filter(Boolean).at(-1) ?? worktree.path}</span>
                <span className="worktree-path">{worktree.path}</span>
              </a>
              <span className={`status-pill status-${worktree.state}`}>{worktree.state}</span>
              {pendingCount > 0 && <span className="pending-pill">{pendingCount} pending</span>}
            </li>
          );
        })}
      </ul>
      {state.worktrees.length === 0 && <p className="card empty-state">No active Herdr sessions found.</p>}
      <div className="dashboard-actions">
      <button className="secondary-button"
        onClick={() => {
          const pairing = loadPairing();
          if (pairing) void registerPush(pairing).then(setNotificationStatus);
        }}
      >
        Enable notifications
      </button>
      <button className="text-button" onClick={() => { clearPairing(); window.location.href = "/pair"; }}>
        Forget pairing
      </button>
      </div>
      {notificationStatus !== "idle" && (
        <p className={notificationStatus === "granted" ? "inline-feedback success" : "inline-feedback error"} role="status">
          {notificationStatus === "granted" && "Notifications enabled."}
          {notificationStatus === "denied" && "Notifications were not enabled. Check browser permissions and install the PWA first."}
          {notificationStatus === "unsupported" && "Push notifications are not supported in this browser."}
        </p>
      )}
    </main>
  );
}
