"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchAllowance, type Allowance } from "./allowance";

export function useBulletinAllowance(address: string | null) {
  const [allowance, setAllowance] = useState<Allowance | null | undefined>();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addressRef = useRef(address);
  const revisionRef = useRef(0);
  const knownRef = useRef<{
    address: string;
    allowance: Allowance | null;
  } | null>(null);
  addressRef.current = address;

  const setKnownAllowance = useCallback((target: string, next: Allowance | null) => {
    knownRef.current = { address: target, allowance: next };
    revisionRef.current += 1;
    if (addressRef.current === target) {
      setAllowance(next);
      setError(null);
      setChecking(false);
    }
  }, []);

  const refresh = useCallback(async (
    showSpinner = true,
    force = false,
  ) => {
    const target = addressRef.current;
    if (!target) {
      setAllowance(undefined);
      setError(null);
      setChecking(false);
      return null;
    }
    const revision = revisionRef.current + 1;
    revisionRef.current = revision;
    if (showSpinner) setChecking(true);
    try {
      const next = await fetchAllowance(target, force);
      if (
        addressRef.current === target &&
        revisionRef.current === revision
      ) {
        setAllowance(next);
        setError(null);
      }
      return next;
    } catch (nextError) {
      if (
        addressRef.current === target &&
        revisionRef.current === revision
      ) {
        if (showSpinner) setAllowance(undefined);
        setError(
          nextError instanceof Error
            ? nextError.message
            : "Could not check Bulletin authorization.",
        );
      }
      throw nextError;
    } finally {
      if (
        showSpinner &&
        addressRef.current === target &&
        revisionRef.current === revision
      ) {
        setChecking(false);
      }
    }
  }, []);

  useEffect(() => {
    revisionRef.current += 1;
    setError(null);
    setChecking(false);
    if (!address) {
      setAllowance(undefined);
      return;
    }

    // Callers own when a lookup actually runs (a connect-time effect, a
    // pre-upload refresh, a manual retry). This effect only ever resets the
    // displayed value to whatever is already known for the newly selected
    // address, so it never races an in-flight ensureAccountBulletinReady call
    // with a second, independent read-only lookup for the same address.
    const known = knownRef.current;
    setAllowance(known?.address === address ? known.allowance : undefined);
  }, [address]);

  return { allowance, checking, error, refresh, setKnownAllowance };
}
