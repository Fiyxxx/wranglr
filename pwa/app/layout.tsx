import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { WranglrShell } from "../components/WranglrShell";
import "./globals.css";
import "@xterm/xterm/css/xterm.css";

export const metadata: Metadata = {
  title: "Wranglr",
  description: "Your Herdr terminal, anywhere",
  manifest: "/manifest.json",
  icons: {
    icon: "/icon.svg",
    apple: "/icon-192.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b0d0c",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body><WranglrShell>{children}</WranglrShell></body>
    </html>
  );
}
