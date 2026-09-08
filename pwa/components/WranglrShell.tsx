"use client";

import { useEffect, useState, type ReactNode } from "react";
import { loadPairing, type PairingInfo, wsUrl } from "../lib/pairing";
import { WranglrProvider } from "../lib/store";
import { ConnectionBadge } from "./ConnectionBadge";

export function WranglrShell({ children }: { children: ReactNode }) {
  const [pairing, setPairing] = useState<PairingInfo | null>();
  const [redirecting, setRedirecting] = useState(false);

  useEffect(() => {
    const saved = loadPairing();
    const path = window.location.pathname;
    if (!saved && path !== "/" && !path.startsWith("/pair")) {
      setRedirecting(true);
      window.location.replace("/pair");
    }
    setPairing(saved);
  }, []);

  if (pairing === undefined || redirecting) {
    return <main className="loading-screen">Loading Wranglr…</main>;
  }

  return (
    <WranglrProvider url={pairing ? wsUrl(pairing) : null}>
      {pairing && <ConnectionBadge />}
      {children}
    </WranglrProvider>
  );
}
