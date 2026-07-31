"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="top-nav" aria-label="Primary navigation">
      <Link className="nav-brand" href="/">
        <span className="nav-brand-name">SoverStore</span>
        <span className="nav-brand-tagline">
          Built with Polkadot Bulletin primitives
        </span>
      </Link>
      <div className="nav-links">
        <Link className={pathname === "/" ? "active" : ""} href="/">
          Storage
        </Link>
        <Link
          className={pathname === "/recovery" ? "active" : ""}
          href="/recovery"
        >
          Recovery
        </Link>
      </div>
    </nav>
  );
}
