import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { WranglrShell } from "../components/WranglrShell";
import "./globals.css";

export const metadata: Metadata = {
  title: "Wranglr",
  description: "A mobile control surface for your coding agents",
  manifest: "/manifest.json",
  icons: {
    icon: "/icon.svg",
    apple: "/icon-192.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#101712",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body><WranglrShell>{children}</WranglrShell></body>
    </html>
  );
}
