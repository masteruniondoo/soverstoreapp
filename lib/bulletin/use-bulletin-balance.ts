"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchBulletinFreeBalance } from "./balance";
import { recoverTimedOutBulletinTransport } from "./recovery";

export function useBulletinBalance(address: string | null) {
  const [balance, setBalance] = useState<bigint | null>(null);
  const [checking, setChecking] = useState(false);

  const refresh = useCallback(async () => {
    if (!address) {
      setBalance(null);
      return;
    }
    setChecking(true);
    try {
      setBalance(await fetchBulletinFreeBalance(address));
    } catch (error) {
      // A timed-out host transport recovers only via a full page reload (see
      // recovery.ts) -- this document is about to be replaced, so leave
      // balance/checking state as-is rather than flashing an error state.
      if (recoverTimedOutBulletinTransport(address, error)) return;
      setBalance(null);
    } finally {
      setChecking(false);
    }
  }, [address]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { balance, checking, refresh };
}
