import { ensureBulletinAllowance } from "@/lib/wallet";
import { queryAccountAuthorization } from "./authorization-query";
import { requestFaucetAllowance } from "./faucet";
import { clearBulletinTransportRecovery } from "./recovery";
import type { StoreAuthorization } from "./store";

const AUTHORIZATION_CONFIRM_ATTEMPTS = 12;
const AUTHORIZATION_CONFIRM_DELAY_MS = 1_000;
const MOBILE_RESPONSE_REMINDER_MS = 12_000;
const MOBILE_RESPONSE_DIAGNOSTIC_MS = 45_000;
const readinessChecks = new Map<string, Promise<Allowance>>();
const allowanceLookups = new Map<string, Promise<Allowance | null>>();

function isAllocationResponseTimeout(error: unknown): error is Error {
  return (
    error instanceof Error &&
    error.message.includes("Bulletin storage allocation timed out")
  );
}

export interface Allowance {
  remainingTransactions: bigint;
  remainingBytes: bigint;
  expiresAtBlock?: number;
  remainingBlocks?: number;
  /** True when the observed chain head has reached the expiration block. */
  expired: boolean;
  exhausted: boolean;
  /** True only while the grant is live and both quotas are positive. */
  usable: boolean;
}

function remaining(used: unknown, allowance: unknown): bigint {
  if (allowance == null) {
    return BigInt((used as string | number | bigint | undefined) ?? 0);
  }
  const cap = BigInt(allowance as string | number | bigint);
  const spent = BigInt((used as string | number | bigint | undefined) ?? 0);
  return cap > spent ? cap - spent : 0n;
}

/**
 * Mirrors Bulletin Dashboard's "Lookup Account": one direct
 * TransactionStorage.Authorizations(Account(address)) read. The optional
 * liveness read is deliberately separate so a slow System.Number query never
 * hides an authorization record that the account lookup already returned.
 */
async function performAllowanceLookup(
  address: string,
  includeLiveness: boolean,
): Promise<Allowance | null> {
  console.info("[soverstore:bulletin] Lookup Account started", {
    address,
    includeLiveness,
  });
  const { authorization, currentBlock } = await queryAccountAuthorization(
    address,
    includeLiveness,
  );
  // A successful storage response proves that the fresh host transport works.
  clearBulletinTransportRecovery();
  if (!authorization) {
    console.info("[soverstore:bulletin] Lookup Account completed: not authorized", {
      address,
    });
    return null;
  }

  const extent = authorization.extent ?? {};
  const remainingTransactions = remaining(
    extent.transactions,
    extent.transactions_allowance,
  );
  const remainingBytes = remaining(
    extent.bytes,
    extent.bytes_allowance,
  );
  const expiration = Number(authorization.expiration);
  let remainingBlocks: number | undefined;
  let expired = false;
  if (includeLiveness) {
    if (currentBlock === undefined) {
      throw new Error("Bulletin did not return its current block number.");
    }
    remainingBlocks = Math.max(0, expiration - currentBlock);
    expired = currentBlock >= expiration;
  }
  const exhausted =
    !expired && (remainingTransactions === 0n || remainingBytes === 0n);
  const allowance = {
    remainingTransactions,
    remainingBytes,
    expiresAtBlock: expiration,
    remainingBlocks,
    expired,
    exhausted,
    usable: !expired && !exhausted,
  };
  console.info("[soverstore:bulletin] Lookup Account completed: authorized", {
    address,
    remainingTransactions: remainingTransactions.toString(),
    remainingBytes: remainingBytes.toString(),
    expiration,
    usable: allowance.usable,
  });
  return allowance;
}

export function fetchAllowance(
  address: string,
  includeLiveness = false,
  force = false,
): Promise<Allowance | null> {
  const key = `${address}:${includeLiveness ? "live" : "lookup"}`;
  const existing = allowanceLookups.get(key);
  if (existing && !force) return existing;

  const pending = performAllowanceLookup(address, includeLiveness).finally(() => {
    if (allowanceLookups.get(key) === pending) allowanceLookups.delete(key);
  });
  allowanceLookups.set(key, pending);
  return pending;
}

/**
 * Requests the host-managed Bulletin allowance and does not report success
 * until the grant is visible and usable on the chain.
 */
async function requestHostAllowance(
  address: string,
  onProgress: (message: string) => void,
  minimum?: StoreAuthorization,
): Promise<Allowance> {
  onProgress("Requesting Bulletin storage allowance from the Product host...");
  const reminder = setTimeout(() => {
    onProgress(
      "Waiting for mobile approval or for Polkadot Desktop to return the result...",
    );
  }, MOBILE_RESPONSE_REMINDER_MS);
  const diagnostic = setTimeout(() => {
    onProgress("Still waiting for the Desktop/mobile bridge. Keep both apps open...");
  }, MOBILE_RESPONSE_DIAGNOSTIC_MS);
  let allocationError: Error | undefined;
  try {
    await ensureBulletinAllowance();
  } catch (error) {
    if (!isAllocationResponseTimeout(error)) throw error;
    // The bridge response can be lost after the phone has approved and the
    // host has submitted the allocation. Treat the chain record as the source
    // of truth before reporting that timeout as a failure.
    allocationError = error;
  } finally {
    clearTimeout(reminder);
    clearTimeout(diagnostic);
  }
  onProgress(
    allocationError
      ? "Desktop response was delayed. Checking Bulletin directly..."
      : "Allowance allocated. Waiting for on-chain confirmation...",
  );

  let lastError: unknown = allocationError;
  let lastAllowance: Allowance | null = null;
  for (let attempt = 1; attempt <= AUTHORIZATION_CONFIRM_ATTEMPTS; attempt += 1) {
    try {
      // Always issue a new storage read while waiting for a grant. This also
      // makes the polling intent explicit if fetchAllowance gains caching.
      const allowance = await fetchAllowance(address, true, true);
      lastError = allocationError;
      lastAllowance = allowance;
      if (
        allowance?.usable &&
        (!minimum ||
          (allowance.remainingTransactions >= minimum.transactions &&
            allowance.remainingBytes >= minimum.bytes))
      ) {
        return allowance;
      }
    } catch (error) {
      lastError = error;
    }
    if (attempt < AUTHORIZATION_CONFIRM_ATTEMPTS) {
      onProgress(
        `Waiting for Bulletin confirmation (${attempt}/${AUTHORIZATION_CONFIRM_ATTEMPTS})...`,
      );
      await new Promise((resolve) =>
        setTimeout(resolve, AUTHORIZATION_CONFIRM_DELAY_MS),
      );
    }
  }

  if (lastError instanceof Error) throw lastError;
  if (lastAllowance?.usable && minimum) {
    throw new Error(
      `The host allowance is active but too small: ${lastAllowance.remainingBytes} bytes and ${lastAllowance.remainingTransactions} transaction(s) remain; this upload needs ${minimum.bytes} bytes and ${minimum.transactions} transaction(s).`,
    );
  }
  throw new Error(
    "The host allocated Bulletin storage, but the usable on-chain allowance was not visible yet. Retry the authorization check.",
  );
}

/**
 * Requests a usable Bulletin allowance for `address`, reporting only
 * informational progress -- no button beyond the initial connect is ever
 * required. Tries the Product host's resource-allocation path first (the
 * intended mechanism, subject to a Desktop/mobile round-trip); if that does
 * not produce a usable on-chain allowance for any reason, falls back
 * automatically to the Devnet //Eve faucet (see faucet.ts), which has no
 * host round-trip to get stuck on.
 */
export async function requestAllowance(
  address: string,
  onProgress: (message: string) => void,
  minimum?: StoreAuthorization,
): Promise<Allowance> {
  try {
    return await requestHostAllowance(address, onProgress, minimum);
  } catch (hostError) {
    console.warn(
      "[soverstore:bulletin] Host-managed allocation did not confirm; falling back to the Devnet faucet.",
      hostError,
    );
    onProgress(
      "Product host allocation did not confirm. Requesting Bulletin storage allowance from the Devnet faucet instead...",
    );
    await requestFaucetAllowance(address, onProgress, minimum);
    onProgress("Faucet authorization finalized. Confirming on Bulletin...");
    const allowance = await fetchAllowance(address, true, true);
    if (allowance && satisfiesMinimum(allowance, minimum)) {
      return allowance;
    }
    throw new Error(
      "The Devnet faucet authorization finalized, but the usable on-chain allowance was still not visible. Retry the authorization check.",
    );
  }
}

function satisfiesMinimum(
  allowance: Allowance,
  minimum?: StoreAuthorization,
): boolean {
  return (
    allowance.usable &&
    (!minimum ||
      (allowance.remainingTransactions >= minimum.transactions &&
        allowance.remainingBytes >= minimum.bytes))
  );
}

/**
 * One shared connect-time flow for Storage and Drops publishers. Existing
 * usable quota is preserved; host allocation is requested only when it is
 * actually missing, expired, exhausted, or too small.
 */
export function ensureAccountBulletinReady(
  address: string,
  onProgress: (message: string) => void,
  minimum?: StoreAuthorization,
): Promise<Allowance> {
  const key = `${address}:${minimum?.transactions ?? 0n}:${minimum?.bytes ?? 0n}`;
  const existing = readinessChecks.get(key);
  if (existing) return existing;

  const pending = (async () => {
    onProgress("Looking up this account on Bulletin...");
    // Read both the authorization and the current Bulletin block. Existence
    // alone is insufficient: an expired record can still retain positive
    // counters and would otherwise be mistaken for a usable allowance.
    const current = await fetchAllowance(address, true);
    if (current && satisfiesMinimum(current, minimum)) {
      onProgress("Existing Bulletin authorization is ready.");
      return current;
    }
    return requestAllowance(address, onProgress, minimum);
  })().finally(() => {
    if (readinessChecks.get(key) === pending) readinessChecks.delete(key);
  });
  readinessChecks.set(key, pending);
  return pending;
}
