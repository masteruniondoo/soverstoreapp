import { ensureBulletinAllowance } from "@/lib/wallet";
import { queryAccountAuthorization } from "./authorization-query";
import { clearBulletinTransportRecovery } from "./recovery";
import type { StoreAuthorization } from "./store";

const AUTHORIZATION_CONFIRM_ATTEMPTS = 12;
const AUTHORIZATION_CONFIRM_DELAY_MS = 1_000;
const readinessChecks = new Map<string, Promise<Allowance>>();
const allowanceLookups = new Map<string, Promise<Allowance | null>>();

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
 * until the grant is visible and usable on the chain. This replaces the old
 * second, in-app Eve faucet flow with the Product host's single resource path.
 */
export async function requestAllowance(
  address: string,
  onProgress: (message: string) => void,
  minimum?: StoreAuthorization,
): Promise<Allowance> {
  onProgress("Requesting Bulletin storage allowance from the Product host...");
  await ensureBulletinAllowance();
  onProgress("Allowance allocated. Waiting for on-chain confirmation...");

  let lastError: unknown;
  let lastAllowance: Allowance | null = null;
  for (let attempt = 1; attempt <= AUTHORIZATION_CONFIRM_ATTEMPTS; attempt += 1) {
    try {
      const allowance = await fetchAllowance(address);
      lastError = undefined;
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
    const current = await fetchAllowance(address);
    if (current && satisfiesMinimum(current, minimum)) {
      // This is intentionally the same single-address lookup as Bulletin
      // Dashboard's "Lookup Account" action. Expiration height is checked only
      // immediately before an upload, where the additional read is relevant.
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
