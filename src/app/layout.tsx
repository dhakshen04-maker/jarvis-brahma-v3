import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "JARVIS BRAHMA - Universal Adaptive Intelligence",
  description: "A modular, multimodal personal intelligence system: voice, memory, verified skills, agents and research.",
};

export const viewport: Viewport = { themeColor: "#02050d", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="hud-grid min-h-screen antialiased">{children}</body>
    </html>
  );
}
