"use client";

import { useEffect, useState } from "react";
import { AppSessionProvider } from "@/components/AppSessionProvider";
import { PolkadotAppRequiredPage } from "@/components/drops/PolkadotAppRequiredPage";
import { DropRouteProvider } from "@/components/drops/DropRouteContext";
import DropsPage from "@/app/drops/page";
import { getDropAppLink } from "@/lib/drops/share-links";
import {
  canRenderDropInterface,
  type SoverStoreRuntime,
} from "@/lib/runtime/runtime-classification";
import { detectSoverStoreRuntime } from "@/lib/runtime/soverstore-runtime";

function setSafeDropMetadata(): () => void {
  const previousTitle = document.title;
  document.title = "Open a SoverStore Drop";
  const values = [
    ["name", "description", "Open this encrypted Drop in Polkadot Browse."],
    ["property", "og:title", "Open a SoverStore Drop"],
    ["property", "og:description", "Open this encrypted Drop in Polkadot Browse."],
    ["name", "twitter:card", "summary"],
    ["name", "twitter:title", "Open a SoverStore Drop"],
    ["name", "twitter:description", "Open this encrypted Drop in Polkadot Browse."],
  ] as const;
  const changed: Array<{
    meta: HTMLMetaElement;
    previousContent: string | null;
    added: boolean;
  }> = [];
  for (const [attribute, key, content] of values) {
    let meta = document.head.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`);
    const added = !meta;
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute(attribute, key);
      document.head.appendChild(meta);
    }
    changed.push({
      meta,
      previousContent: meta.getAttribute("content"),
      added,
    });
    meta.content = content;
  }
  return () => {
    document.title = previousTitle;
    for (const item of changed) {
      if (item.added) {
        item.meta.remove();
      } else if (item.previousContent === null) {
        item.meta.removeAttribute("content");
      } else {
        item.meta.content = item.previousContent;
      }
    }
  };
}

export function DropEntryRoute({ dropId }: { dropId: string }) {
  const [runtime, setRuntime] = useState<SoverStoreRuntime | null>(null);
  const dropLink = getDropAppLink(dropId);

  useEffect(setSafeDropMetadata, []);
  useEffect(() => {
    let active = true;
    void detectSoverStoreRuntime().then(
      (detected) => {
        if (active) setRuntime(detected);
      },
      () => {
        if (active) setRuntime("unknown");
      },
    );
    return () => {
      active = false;
    };
  }, []);

  if (runtime === null) {
    return (
      <main className="shell app-required-loading" aria-busy="true">
        <span className="story-kicker">SoverStore Drop</span>
        <p>Checking the Polkadot application environment...</p>
      </main>
    );
  }

  if (!canRenderDropInterface(runtime)) {
    return <PolkadotAppRequiredPage dropLink={dropLink} />;
  }

  return (
    <AppSessionProvider>
      <DropRouteProvider dropId={dropId}>
        <DropsPage />
      </DropRouteProvider>
    </AppSessionProvider>
  );
}
