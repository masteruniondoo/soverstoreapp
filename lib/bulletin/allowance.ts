import { queryAccountAuthorization } from "./authorization-query";
import {
  BulletinAuthorizationCoordinator,
  type BulletinAuthorizationProgress,
} from "./authorization-flow";
import { requestFaucetAllowance } from "./faucet";
import { clearBulletinTransportRecovery } from "./recovery";

const authorizationCoordinator = new BulletinAuthorizationCoordinator<Allowance>();
const allowanceLookups = new Map<string, Promise<Allowance | null>>();

export interface Allowance {
  /** Remaining soft-priority transaction budget. It never gates `store`. */
  remainingTransactions: bigint;
  /** Remaining soft-priority byte budget. It never gates `store`. */
  remainingBytes: bigint;
  expiresAtBlock?: number;
  remainingBlocks?: number;
  /** True when the observed chain head has reached the expiration block. */
  expired: boolean;
  /** Informational only: an active authorization remains usable when true. */
  exhausted: boolean;
  /** Authorization exists and has not expired; soft counters do not affect it. */
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
 * Mirrors Bulletin Console's account lookup, with one additional current-block
 * read so an expired-but-still-present record cannot be reported as active.
 */
async function performAllowanceLookup(address: string): Promise<Allowance | null> {
  console.info("[soverstore:bulletin] Account authorization lookup started", {
    address,
  });
  const { authorization, currentBlock } = await queryAccountAuthorization(
    address,
    true,
  );
  clearBulletinTransportRecovery();
  if (!authorization) {
    console.info("[soverstore:bulletin] Account is not authorized", { address });
    return null;
  }

  const extent = authorization.extent ?? {};
  const remainingTransactions = remaining(
    extent.transactions,
    extent.transactions_allowance,
  );
  const remainingBytes = remaining(extent.bytes, extent.bytes_allowance);
  const parsedExpiration =
    authorization.expiration == null
      ? undefined
      : Number(authorization.expiration);
  const expiration =
    parsedExpiration !== undefined && Number.isFinite(parsedExpiration)
      ? parsedExpiration
      : undefined;

  if (expiration !== undefined && currentBlock === undefined) {
    throw new Error("Bulletin did not return its current block number.");
  }
  const expired =
    expiration !== undefined &&
    currentBlock !== undefined &&
    currentBlock >= expiration;
  const exhausted = remainingTransactions === 0n || remainingBytes === 0n;
  const allowance: Allowance = {
    remainingTransactions,
    remainingBytes,
    expiresAtBlock: expiration,
    remainingBlocks:
      expiration === undefined || currentBlock === undefined
        ? undefined
        : Math.max(0, expiration - currentBlock),
    expired,
    exhausted,
    usable: !expired,
  };

  console.info("[soverstore:bulletin] Account authorization lookup completed", {
    address,
    expiration,
    expired,
    softTransactionsRemaining: remainingTransactions.toString(),
    softBytesRemaining: remainingBytes.toString(),
  });
  return allowance;
}

/** Every call is a fresh chain read; `force` only bypasses an in-flight read. */
export function fetchAllowance(
  address: string,
  force = false,
): Promise<Allowance | null> {
  const existing = allowanceLookups.get(address);
  if (existing && !force) return existing;

  const pending = performAllowanceLookup(address).finally(() => {
    if (allowanceLookups.get(address) === pending) {
      allowanceLookups.delete(address);
    }
  });
  allowanceLookups.set(address, pending);
  return pending;
}

function forwardProgress(
  onProgress: (message: string) => void,
  progress: BulletinAuthorizationProgress,
): void {
  onProgress(progress.message);
}

/**
 * Complete automatic flow for one account:
 * fresh lookup -> direct Devnet faucet authorization only when inactive ->
 * wait for finalization -> one fresh lookup. This is the same authorization
 * mechanism used by the official Bulletin Console and never asks the user's
 * mobile wallet to approve an allowance.
 */
export function ensureAccountBulletinReady(
  address: string,
  onProgress: (message: string) => void,
): Promise<Allowance> {
  return authorizationCoordinator.ensure(
    address,
    {
      lookup: (force) => fetchAllowance(address, force),
      isActive: (allowance) => allowance.usable,
      authorize: (report) => requestFaucetAllowance(address, report),
      // The reference Console waits for Finalized, then reads storage once.
      confirmationAttempts: 1,
    },
    (progress) => forwardProgress(onProgress, progress),
  );
}
