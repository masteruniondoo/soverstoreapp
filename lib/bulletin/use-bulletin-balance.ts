"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchBulletinFreeBalance } from "./balance";

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
    } catch {
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
