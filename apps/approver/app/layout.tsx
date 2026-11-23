import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import "./globals.css";

// Rendered per request so every response gets a fresh CSP nonce (proxy.ts).
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "cyphos-guard approver",
  description: "Approve and revoke your AI agents' spending",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    // suppressHydrationWarning: /theme.js sets data-theme on <html> before React hydrates.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Light/dark switch, shared with cyphosguard.com; copied from site/theme.js by the prebuild/predev scripts. */}
        <script src="/theme.js" nonce={nonce} />
      </head>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
