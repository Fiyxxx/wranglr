"use client";

import { useWranglr } from "../../lib/store";
import { loadPairing } from "../../lib/pairing";
import { registerPush } from "../../lib/push";

export default function DashboardPage() {
  const { state } = useWranglr();

  return (
    <main>
      <h1>Worktrees</h1>
      <ul>
        {state.worktrees.map((worktree) => {
          const pendingCount = state.pendingApprovals.filter((a) => a.worktreePath === worktree.path).length;
          return (
            <li key={worktree.path}>
              <a href={`/worktree/${encodeURIComponent(worktree.path)}`}>{worktree.path}</a>
              <span> {worktree.state}</span>
              {pendingCount > 0 && <span> {pendingCount} pending</span>}
            </li>
          );
        })}
      </ul>
      <button
        onClick={() => {
          const pairing = loadPairing();
          if (pairing) void registerPush(pairing);
        }}
      >
        Enable notifications
      </button>
    </main>
  );
}
