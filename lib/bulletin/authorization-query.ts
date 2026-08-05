import { Enum } from "polkadot-api";
import { subscribeConnectionStatus } from "@parity/truapi/sandbox";
import { getBulletin, resetBulletin } from "./client";

const DIRECT_QUERY_TIMEOUT_MS = 8_000;
const HOST_READY_TIMEOUT_MS = 5_000;
const RETRY_DELAY_MS = 1_500;

/**
 * Waits for the host transport to report "connected" before issuing a query.
 * Right after a wallet connect or a fresh document load, the host channel
 * handshake can still be settling; querying before it lands is what produces
 * a spurious timeout that a plain retry does not fix, since it races the
 * same not-yet-ready channel again. Rejecting on timeout prevents a query from
 * being sent through a transport that never became ready.
 */
function waitForHostConnected(timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    let cleanupAfterSubscribe = false;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (unsubscribe) unsubscribe();
      else cleanupAfterSubscribe = true;
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            `Bulletin authorization query timed out after ${timeoutMs}ms while waiting for the host connection.`,
          ),
        ),
      timeoutMs,
    );
    unsubscribe = subscribeConnectionStatus((status) => {
      if (status === "connected") finish();
    });
    // subscribeConnectionStatus emits synchronously. If it reported connected
    // before returning its unsubscribe callback, release that listener now.
    if (cleanupAfterSubscribe) unsubscribe();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  stage: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `Bulletin authorization query timed out after ${timeoutMs}ms while waiting for ${stage}.`,
          ),
        ),
      timeoutMs,
    );
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isQueryTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("Bulletin authorization query timed out")
  );
}

type AuthorizationRecord = {
  extent?: {
    transactions?: string | number | bigint;
    transactions_allowance?: string | number | bigint;
    bytes?: string | number | bigint;
    bytes_allowance?: string | number | bigint;
  };
  expiration: string | number | bigint;
};

export type AuthorizationStorageResult = {
  authorization?: AuthorizationRecord;
  currentBlock?: number;
};

/**
 * One direct TransactionStorage.Authorizations(Account(address)) read via the
 * host-routed PAPI client (the same client store.ts uses for uploads), plus
 * the optional System.Number liveness read. A local Promise timeout bounds the
 * wait without aborting PAPI: AbortSignal cancellation emits a stop-operation
 * host frame that older Polkadot Desktop builds cannot decode.
 */
async function queryOnce(
  address: string,
  includeCurrentBlock: boolean,
): Promise<AuthorizationStorageResult> {
  const { api } = await withTimeout(
    getBulletin(),
    DIRECT_QUERY_TIMEOUT_MS,
    "the Bulletin chain client",
  );
  const authorization = await withTimeout(
    api.query.TransactionStorage.Authorizations.getValue(
      Enum("Account", address),
    ) as Promise<AuthorizationRecord | undefined>,
    DIRECT_QUERY_TIMEOUT_MS,
    "the account authorization",
  );
  if (!includeCurrentBlock || !authorization) return { authorization };

  // Read liveness only when the caller needs it and an authorization exists.
  // This keeps the ordinary connect-time Lookup Account path to one storage
  // read and gives each required value its own clear timeout stage.
  const currentBlock = await withTimeout(
    api.query.System.Number.getValue() as Promise<number>,
    DIRECT_QUERY_TIMEOUT_MS,
    "the current Bulletin block",
  );
  return { authorization, currentBlock };
}

export async function queryAccountAuthorization(
  address: string,
  includeCurrentBlock: boolean,
): Promise<AuthorizationStorageResult> {
  await waitForHostConnected(HOST_READY_TIMEOUT_MS);
  try {
    return await queryOnce(address, includeCurrentBlock);
  } catch (error) {
    console.warn("[soverstore:bulletin] Direct lookup attempt failed", {
      address,
      attempt: 1,
      error: error instanceof Error ? error.message : String(error),
    });
    // A timed-out query is still alive inside PAPI. Do not abort or destroy it:
    // either action sends the incompatible stop-operation frame. The existing
    // recovery flow reloads the document and obtains a genuinely fresh port.
    if (isQueryTimeout(error)) throw error;

    // A normally rejected operation has finished and can be torn down safely.
    // Recreate the SDK client so this retry cannot reuse stale chain state.
    await resetBulletin();
    await delay(RETRY_DELAY_MS);
    await waitForHostConnected(HOST_READY_TIMEOUT_MS);
    try {
      return await queryOnce(address, includeCurrentBlock);
    } catch (retryError) {
      console.warn("[soverstore:bulletin] Direct lookup attempt failed", {
        address,
        attempt: 2,
        error:
          retryError instanceof Error
            ? retryError.message
            : String(retryError),
      });
      throw retryError;
    }
  }
}
