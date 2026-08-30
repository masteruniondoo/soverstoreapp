"use client";

const RECOVERY_KEY = "soverstore.bulletin.transport-recovery.v1";
const RECOVERY_WINDOW_MS = 2 * 60_000;

export type BulletinTransportRecovery = {
  address: string;
  requestedAt: number;
};

function parseRecovery(raw: string | null): BulletinTransportRecovery | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<BulletinTransportRecovery>;
    if (
      typeof value.address !== "string" ||
      typeof value.requestedAt !== "number"
    ) {
      return null;
    }
    return { address: value.address, requestedAt: value.requestedAt };
  } catch {
    return null;
  }
}

export function getBulletinTransportRecovery(): BulletinTransportRecovery | null {
  if (typeof window === "undefined") return null;
  const recovery = parseRecovery(window.sessionStorage.getItem(RECOVERY_KEY));
  if (!recovery) return null;
  if (Date.now() - recovery.requestedAt > RECOVERY_WINDOW_MS) {
    window.sessionStorage.removeItem(RECOVERY_KEY);
    return null;
  }
  return recovery;
}

export function clearBulletinTransportRecovery(): void {
  if (typeof window !== "undefined") {
    window.sessionStorage.removeItem(RECOVERY_KEY);
  }
}

/**
 * True when an error is a host-transport timeout that only a fresh document
 * (not another in-session retry) can recover from: Desktop can swap the
 * underlying MessagePort at any point after wallet connection, and the page
 * has no way to notice that swap without reloading. Bulletin authorization
 * itself uses the direct Devnet faucet transaction; only a host-routed chain
 * query (authorization lookup, balance, retention period, ...) can require
 * this recovery -- see lib/bulletin/host-query.ts.
 */
export function isBulletinTransportTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Bulletin host query timed out");
}

/**
 * A timed-out Desktop ChainHead does not recover through another PAPI query;
 * only a fresh document receives a new host MessagePort. Reload at most once
 * automatically, retain the address in session storage, and let
 * AppSessionProvider reconnect it automatically after the new document
 * starts. The automatic attempt is bounded so a bad transport cannot create a
 * reload loop; any remaining failure is shown as informational status.
 */
export function recoverTimedOutBulletinTransport(
  address: string,
  error: unknown,
): boolean {
  if (typeof window === "undefined") return false;
  if (!isBulletinTransportTimeout(error)) return false;

  // Do not create a reload loop if the fresh Desktop transport also fails.
  if (getBulletinTransportRecovery()) return false;

  window.sessionStorage.setItem(
    RECOVERY_KEY,
    JSON.stringify({ address, requestedAt: Date.now() }),
  );
  window.location.reload();
  return true;
}
