"use client";

import { useWranglr } from "../lib/store";

const LABELS = {
  connecting: "Connecting…",
  open: "Connected",
  closed: "Disconnected",
} as const;

export function ConnectionBadge() {
  const { state } = useWranglr();
  return <div data-status={state.connectionStatus}>{LABELS[state.connectionStatus]}</div>;
}
