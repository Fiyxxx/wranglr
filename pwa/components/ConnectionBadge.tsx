"use client";

import { useWranglr } from "../lib/store";

const LABELS = {
  connecting: "Connecting…",
  open: "Connected",
  closed: "Disconnected",
} as const;

export function ConnectionBadge() {
  const { state } = useWranglr();
  return (
    <div className="connection-badge" data-status={state.connectionStatus} role="status">
      <span aria-hidden="true" />
      {LABELS[state.connectionStatus]}
    </div>
  );
}
