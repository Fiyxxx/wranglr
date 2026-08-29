"use client";

import type { ReactNode } from "react";
import { WranglrProvider } from "../lib/store";
import { ConnectionBadge } from "../components/ConnectionBadge";
import { loadPairing, wsUrl } from "../lib/pairing";

export default function RootLayout({ children }: { children: ReactNode }) {
  const pairing = loadPairing();

  return (
    <html lang="en">
      <head>
        <title>Wranglr</title>
        <link rel="manifest" href="/manifest.json" />
      </head>
      <body>
        {pairing ? (
          <WranglrProvider url={wsUrl(pairing)}>
            <ConnectionBadge />
            {children}
          </WranglrProvider>
        ) : (
          children
        )}
      </body>
    </html>
  );
}
