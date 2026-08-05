import type { Metadata } from "next";
import { AppRouteContent } from "@/components/AppRouteContent";
import { ChunkLoadRecovery } from "@/components/ChunkLoadRecovery";
import "./globals.css";

export const metadata: Metadata = {
  title: "SoverStore - Bulletin storage",
  description:
    "Encrypt a file locally, upload it to decentralized storage, and recover it with a recovery file.",
  openGraph: {
    title: "Open a SoverStore Drop",
    description: "Open this encrypted Drop in the Polkadot App.",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Open a SoverStore Drop",
    description: "Open this encrypted Drop in the Polkadot App.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <ChunkLoadRecovery />
        <AppRouteContent>{children}</AppRouteContent>
      </body>
    </html>
  );
}
