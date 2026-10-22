import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Companion Playground",
  description: "Umbrella dashboard: chat, voice, memory and tests for the companion (Umbrella).",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
