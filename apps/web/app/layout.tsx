import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "MOTIF Studio — local-first video editor",
  description: "Edit, caption and export in 4K on your own machine. Cloud projects, version history and team workspaces when you want them.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
