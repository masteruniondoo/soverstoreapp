"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchAllowance, type Allowance } from "./allowance";

export function useBulletinAllowance(
  address: string | null,
  autoCheck = true,
) {
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
    includeLiveness = false,
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
      const next = await fetchAllowance(target, includeLiveness, force);
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

    const known = knownRef.current;
    if (known?.address === address) {
      setAllowance(known.allowance);
      if (autoCheck) void refresh(false).catch(() => undefined);
    } else {
      setAllowance(undefined);
      if (autoCheck) void refresh(true).catch(() => undefined);
    }
  }, [address, autoCheck, refresh]);

  return { allowance, checking, error, refresh, setKnownAllowance };
}
