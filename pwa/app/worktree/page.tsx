"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useWranglr } from "../../lib/store";

export function WorktreeDetail({ worktreePath }: { worktreePath: string }) {
  const { state, send } = useWranglr();
  const [prompt, setPrompt] = useState("");
  const [submittedPromptId, setSubmittedPromptId] = useState<string | null>(null);

  const events = state.hookEvents.filter((event) => event.worktreePath === worktreePath);
  const approvals = state.pendingApprovals.filter((approval) => approval.worktreePath === worktreePath);
  const promptResult = submittedPromptId ? state.promptResults.find((result) => result.id === submittedPromptId) : undefined;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const text = prompt.trim();
    if (!text) return;
    const id = crypto.randomUUID();
    setSubmittedPromptId(id);
    send({ type: "prompt", id, worktreePath, text });
    setPrompt("");
  }

  return (
    <main className="page">
      <a className="back-link" href="/dashboard">← All worktrees</a>
      <header className="hero compact-hero">
        <p className="eyebrow">Agent session</p>
        <h1>{worktreePath.split("/").filter(Boolean).at(-1) ?? worktreePath}</h1>
        <p className="worktree-path">{worktreePath}</p>
      </header>

      <section>
        <div className="section-heading">
          <h2>Pending approvals</h2>
          {approvals.length > 0 && <span className="pending-pill">{approvals.length}</span>}
        </div>
        {approvals.length === 0 && <p className="card empty-state">Nothing needs approval.</p>}
        {approvals.map((approval) => (
          <article className="card approval-card" key={approval.id}>
            <div className="approval-title">
              <strong>{approval.tool}</strong>
              <span className={`risk-pill risk-${approval.risk}`}>{approval.risk} risk</span>
            </div>
            <pre>{JSON.stringify(approval.input, null, 2)}</pre>
            <div className="button-row">
              <button className="approve-button" disabled={state.connectionStatus !== "open"} onClick={() => send({ type: "approval_response", id: approval.id, decision: "approve" })}>Approve</button>
              <button className="reject-button" disabled={state.connectionStatus !== "open"} onClick={() => send({ type: "approval_response", id: approval.id, decision: "reject" })}>Reject</button>
            </div>
          </article>
        ))}
      </section>

      <section>
        <h2>Recent activity</h2>
        {events.length === 0 && <p className="card empty-state">No hook activity yet.</p>}
        <ul className="activity-list">
          {events.slice().reverse().map((event, index) => (
            <li className="card" key={`${event.hook}-${event.tool}-${index}`}>
              <span>{event.tool}</span><small>{event.hook}</small>
            </li>
          ))}
        </ul>
      </section>

      <form className="prompt-bar" onSubmit={handleSubmit}>
        <label className="sr-only" htmlFor="prompt">Prompt</label>
        <input id="prompt" placeholder="Ask the agent to…" value={prompt} onChange={(event) => setPrompt(event.target.value)} />
        <button className="primary-button" type="submit" disabled={state.connectionStatus !== "open"}>Send</button>
      </form>
      {promptResult && (
        <p className={promptResult.accepted ? "prompt-result success" : "prompt-result error"} role="status">
          {promptResult.accepted ? "Prompt delivered to Herdr." : promptResult.error}
        </p>
      )}
      {submittedPromptId && !promptResult && <p className="prompt-result" role="status">Delivering prompt…</p>}
    </main>
  );
}

export default function WorktreePage() {
  const [worktreePath, setWorktreePath] = useState<string | null>(null);

  useEffect(() => {
    setWorktreePath(new URLSearchParams(window.location.search).get("path") ?? "");
  }, []);

  if (worktreePath === null) return <main className="loading-screen">Loading worktree…</main>;
  if (!worktreePath) return <main className="page"><p className="card empty-state">No worktree was selected.</p></main>;
  return <WorktreeDetail worktreePath={worktreePath} />;
}
