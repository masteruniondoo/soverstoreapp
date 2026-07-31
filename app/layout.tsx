import type { Metadata } from "next";
import { ChunkLoadRecovery } from "@/components/ChunkLoadRecovery";
import "./globals.css";

export const metadata: Metadata = {
  title: "SoverStore - Bulletin storage",
  description:
    "Encrypt a file locally, upload it to decentralized storage, and recover it with a recovery file.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;700;900&family=IBM+Plex+Mono:wght@400;500;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <ChunkLoadRecovery />
        {children}
      </body>
    </html>
  );
}
