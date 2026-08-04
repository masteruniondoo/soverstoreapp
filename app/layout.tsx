import type { Metadata } from "next";
import { AppSessionProvider } from "@/components/AppSessionProvider";
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
      <body>
        <ChunkLoadRecovery />
        <AppSessionProvider>{children}</AppSessionProvider>
      </body>
    </html>
  );
}
