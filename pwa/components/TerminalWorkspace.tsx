"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { clearPairing, loadPairing } from "../lib/pairing";
import { registerPush } from "../lib/push";
import { useWranglr } from "../lib/store";
import { TerminalView } from "./TerminalView";

const STATUS_LABELS = {
  connecting: "connecting",
  open: "live",
  closed: "offline",
} as const;

const QUICK_KEYS = [
  { label: "Esc", keys: ["esc"] },
  { label: "Tab", keys: ["tab"] },
  { label: "↑", keys: ["up"] },
  { label: "↓", keys: ["down"] },
  { label: "←", keys: ["left"] },
  { label: "→", keys: ["right"] },
  { label: "Enter", keys: ["enter"] },
] as const;

function nameFromPath(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

export function TerminalWorkspace({ initialWorktreePath }: { initialWorktreePath?: string } = {}) {
  const { state, send } = useWranglr();
  const [selectedPaneId, setSelectedPaneId] = useState<string | null>(null);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [ctrlActive, setCtrlActive] = useState(false);
  const [altActive, setAltActive] = useState(false);
  const [notificationStatus, setNotificationStatus] = useState<"idle" | "granted" | "denied" | "unsupported">("idle");
  const terminalFocusRef = useRef<() => void>(() => {});
  const onTerminalReady = useCallback((focus: () => void) => {
    terminalFocusRef.current = focus;
  }, []);

  useEffect(() => {
    const currentStillExists = state.worktrees.some((worktree) => worktree.herdrPaneId === selectedPaneId);
    if (currentStillExists) return;
    const preferred = initialWorktreePath
      ? state.worktrees.find((worktree) => worktree.path === initialWorktreePath)
      : undefined;
    setSelectedPaneId(preferred?.herdrPaneId ?? state.worktrees[0]?.herdrPaneId ?? null);
  }, [initialWorktreePath, selectedPaneId, state.worktrees]);

  const activeWorktree = state.worktrees.find((worktree) => worktree.herdrPaneId === selectedPaneId) ?? null;
  const activeTerminal = selectedPaneId ? state.terminals[selectedPaneId] : undefined;
  const approvals = useMemo(
    () => state.pendingApprovals.filter((approval) => approval.worktreePath === activeWorktree?.path),
    [activeWorktree?.path, state.pendingApprovals],
  );

  const sendTerminalInput = useCallback((input: { text?: string; keys?: string[] }) => {
    if (!selectedPaneId || state.connectionStatus !== "open") return;
    if (input.text?.length === 1 && (ctrlActive || altActive)) {
      const modifiers = [ctrlActive && "ctrl", altActive && "alt"].filter(Boolean).join("+");
      send({ type: "terminal_input", paneId: selectedPaneId, keys: [`${modifiers}+${input.text.toLowerCase()}`] });
      setCtrlActive(false);
      setAltActive(false);
      return;
    }
    send({ type: "terminal_input", paneId: selectedPaneId, ...input });
  }, [altActive, ctrlActive, selectedPaneId, send, state.connectionStatus]);

  function selectSession(event: MouseEvent<HTMLAnchorElement>, paneId: string | null) {
    if (!paneId) return;
    event.preventDefault();
    setSelectedPaneId(paneId);
    setSessionMenuOpen(false);
  }

  return (
    <main className="terminal-app">
      <header className="app-titlebar">
        <button className="session-menu-button" onClick={() => setSessionMenuOpen((open) => !open)} aria-label="Toggle sessions">
          <span />
          <span />
        </button>
        <div className="wordmark"><span>wranglr</span><i>/</i>herdr</div>
        <div className="connection-state" data-status={state.connectionStatus} role="status">
          <span />{STATUS_LABELS[state.connectionStatus]}
        </div>
        <button
          className="icon-button"
          aria-label="Enable notifications"
          title="Enable notifications"
          onClick={() => {
            const pairing = loadPairing();
            if (pairing) void registerPush(pairing).then(setNotificationStatus);
          }}
        >
          ◇
        </button>
      </header>

      <div className="workspace-frame">
        <aside className={`session-rail ${sessionMenuOpen ? "is-open" : ""}`}>
          <div className="rail-heading">
            <span>Sessions</span>
            <b>{state.worktrees.length}</b>
          </div>
          <nav className="session-list" aria-label="Herdr sessions">
            {state.worktrees.map((worktree) => {
              const pendingCount = state.pendingApprovals.filter((approval) => approval.worktreePath === worktree.path).length;
              const selected = worktree.herdrPaneId === selectedPaneId;
              return (
                <a
                  className="session-item"
                  data-selected={selected}
                  href={`/worktree?path=${encodeURIComponent(worktree.path)}`}
                  key={worktree.herdrPaneId ?? worktree.path}
                  onClick={(event) => selectSession(event, worktree.herdrPaneId)}
                >
                  <span className={`session-dot status-${worktree.state}`} />
                  <span className="session-copy">
                    <strong>{nameFromPath(worktree.path)}</strong>
                    <small>{worktree.path}</small>
                  </span>
                  {pendingCount > 0 && <em>{pendingCount} pending</em>}
                </a>
              );
            })}
          </nav>
          {state.worktrees.length === 0 && <p className="rail-empty">No Herdr panes detected.</p>}
          <button className="forget-button" onClick={() => { clearPairing(); window.location.href = "/pair"; }}>
            disconnect
          </button>
        </aside>

        {sessionMenuOpen && <button className="rail-scrim" aria-label="Close sessions" onClick={() => setSessionMenuOpen(false)} />}

        <section className="terminal-pane">
          {activeWorktree ? (
            <>
              <div className="pane-tabbar">
                <div className="pane-tab">
                  <span className={`session-dot status-${activeWorktree.state}`} />
                  <strong>{nameFromPath(activeWorktree.path)}</strong>
                  <small>{activeWorktree.state}</small>
                </div>
                <span className="pane-id">{activeWorktree.herdrPaneId}</span>
              </div>

              {approvals.length > 0 && (
                <div className="approval-strip">
                  {approvals.map((approval) => (
                    <details key={approval.id}>
                      <summary>
                        <span><b>{approval.tool}</b> needs approval <i>{approval.risk}</i></span>
                        <span className="approval-actions">
                          <button onClick={(event) => { event.preventDefault(); send({ type: "approval_response", id: approval.id, decision: "reject" }); }}>Reject</button>
                          <button className="allow" onClick={(event) => { event.preventDefault(); send({ type: "approval_response", id: approval.id, decision: "approve" }); }}>Approve</button>
                        </span>
                      </summary>
                      <pre>{JSON.stringify(approval.input, null, 2)}</pre>
                    </details>
                  ))}
                </div>
              )}

              <div className="terminal-stage">
                {activeTerminal ? (
                  <TerminalView key={activeTerminal.paneId} pane={activeTerminal} onInput={sendTerminalInput} onReady={onTerminalReady} />
                ) : (
                  <div className="terminal-loading"><span>▌</span> reading pane output…</div>
                )}
              </div>

              <footer className="terminal-footer">
                <div className="terminal-statusline">
                  <span className="mode-label">HERDR</span>
                  <span>{nameFromPath(activeWorktree.path)}</span>
                  <span className="status-spacer" />
                  {activeTerminal?.truncated && <span className="truncated-label">scrollback truncated</span>}
                  <span>{activeWorktree.state}</span>
                </div>
                <div className="quick-keys" aria-label="Terminal keys">
                  <button data-active={ctrlActive} onClick={() => { setCtrlActive((active) => !active); terminalFocusRef.current(); }}>Ctrl</button>
                  <button data-active={altActive} onClick={() => { setAltActive((active) => !active); terminalFocusRef.current(); }}>Opt</button>
                  {QUICK_KEYS.map((quickKey) => (
                    <button key={quickKey.label} onClick={() => { sendTerminalInput({ keys: [...quickKey.keys] }); terminalFocusRef.current(); }}>
                      {quickKey.label}
                    </button>
                  ))}
                  <button className="keyboard-button" aria-label="Open keyboard" onClick={() => terminalFocusRef.current()}>⌨</button>
                </div>
              </footer>
            </>
          ) : (
            <div className="no-session">
              <span className="prompt-glyph">›_</span>
              <h1>No live Herdr session</h1>
              <p>Start or attach to a Herdr agent pane. It will appear here automatically.</p>
            </div>
          )}
        </section>
      </div>

      {notificationStatus !== "idle" && (
        <button className="toast" onClick={() => setNotificationStatus("idle")}>
          {notificationStatus === "granted" ? "Notifications enabled" : "Notifications unavailable"}
        </button>
      )}
    </main>
  );
}
