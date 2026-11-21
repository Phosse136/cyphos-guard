import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

// Rendered per request so every response gets a fresh CSP nonce (proxy.ts).
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "cyphos-guard approver",
  description: "Approve and revoke your AI agents' spending",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
