"use client";

import { useEffect, useState } from "react";
import { TerminalWorkspace } from "../../components/TerminalWorkspace";

export default function WorktreePage() {
  const [worktreePath, setWorktreePath] = useState<string | undefined>();

  useEffect(() => {
    setWorktreePath(new URLSearchParams(window.location.search).get("path") ?? undefined);
  }, []);

  return <TerminalWorkspace initialWorktreePath={worktreePath} />;
}
