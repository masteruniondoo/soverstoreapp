"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function Nav() {
  const pathname = usePathname();
  const activePath =
    pathname === "/" ? pathname : pathname.replace(/\/+$/, "");

  return (
    <nav className="top-nav" aria-label="Primary navigation">
      <Link className="nav-brand" href="/">
        <span className="nav-brand-name">SoverStore</span>
        <span className="nav-brand-tagline">
          A Polkadot Product - storage on the Bulletin Chain, signing on your
          device
        </span>
      </Link>
      <div className="nav-links">
        <Link className={activePath === "/" ? "active" : ""} href="/">
          Storage
        </Link>
        <Link
          className={activePath === "/recovery" ? "active" : ""}
          href="/recovery"
        >
          Recovery
        </Link>
        <Link
          className={activePath === "/drops" ? "active" : ""}
          href="/drops"
        >
          Drops
        </Link>
        <Link
          className={activePath === "/about" ? "active" : ""}
          href="/about"
        >
          About
        </Link>
      </div>
    </nav>
  );
}
