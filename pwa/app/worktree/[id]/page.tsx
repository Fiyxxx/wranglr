"use client";

import { useState, type FormEvent } from "react";
import { useWranglr } from "../../../lib/store";

export function WorktreeDetail({ worktreePath }: { worktreePath: string }) {
  const { state, send } = useWranglr();
  const [prompt, setPrompt] = useState("");

  const events = state.hookEvents.filter((e) => e.worktreePath === worktreePath);
  const approvals = state.pendingApprovals.filter((a) => a.worktreePath === worktreePath);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    send({ type: "prompt", worktreePath, text: prompt });
    setPrompt("");
  }

  return (
    <main>
      <h1>{worktreePath}</h1>

      <section>
        <h2>Pending approvals</h2>
        {approvals.map((approval) => (
          <div key={approval.id}>
            <span>{approval.tool}</span>
            <span> {approval.risk}</span>
            <button onClick={() => send({ type: "approval_response", id: approval.id, decision: "approve" })}>
              Approve
            </button>
            <button onClick={() => send({ type: "approval_response", id: approval.id, decision: "reject" })}>
              Reject
            </button>
          </div>
        ))}
      </section>

      <section>
        <h2>Activity</h2>
        <ul>
          {events.map((event, i) => (
            <li key={i}>{event.tool}</li>
          ))}
        </ul>
      </section>

      <form onSubmit={handleSubmit}>
        <label htmlFor="prompt">Prompt</label>
        <input id="prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        <button type="submit">Send</button>
      </form>
    </main>
  );
}

export default async function WorktreePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <WorktreeDetail worktreePath={decodeURIComponent(id)} />;
}
