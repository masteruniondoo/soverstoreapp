"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { AppSessionProvider } from "@/components/AppSessionProvider";
import { DropEntryRoute } from "@/components/drops/DropEntryRoute";
import {
  resolveDropLocation,
  type DropPathResult,
} from "@/lib/drops/drop-route";
import { DROP_ROUTE_CHANGE_EVENT } from "@/lib/drops/in-app-navigation";
import { DROP_SHARE_ORIGIN } from "@/lib/runtime-config";

export function AppRouteContent({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [route, setRoute] = useState<DropPathResult | null>(null);
  const allowInitialReferrerRecovery = useRef(true);

  useEffect(() => {
    const resolveRoute = () => {
      const referrer = allowInitialReferrerRecovery.current
        ? document.referrer
        : "";
      allowInitialReferrerRecovery.current = false;
      setRoute(resolveDropLocation(
        window.location.pathname,
        referrer,
        DROP_SHARE_ORIGIN,
        window.location.hash,
      ));
    };
    resolveRoute();
    window.addEventListener("popstate", resolveRoute);
    window.addEventListener("hashchange", resolveRoute);
    window.addEventListener(DROP_ROUTE_CHANGE_EVENT, resolveRoute);
    return () => {
      window.removeEventListener("popstate", resolveRoute);
      window.removeEventListener("hashchange", resolveRoute);
      window.removeEventListener(DROP_ROUTE_CHANGE_EVENT, resolveRoute);
    };
  }, [pathname]);

  if (route === null) {
    return <main className="shell app-required-loading" aria-busy="true" />;
  }
  if (route.kind === "drop") {
    return <DropEntryRoute dropId={route.dropId} />;
  }
  if (route.kind === "invalid") {
    return (
      <main className="shell app-required-page">
        <span className="story-kicker">Invalid Drop link</span>
        <h1>This Drop link is not valid</h1>
        <p>The link must contain one valid on-chain Drop identifier.</p>
      </main>
    );
  }
  return <AppSessionProvider>{children}</AppSessionProvider>;
}
