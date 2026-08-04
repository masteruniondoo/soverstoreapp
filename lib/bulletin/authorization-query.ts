import { Enum } from "polkadot-api";
import { getBulletin } from "./client";

const DIRECT_QUERY_TIMEOUT_MS = 8_000;
const DIRECT_QUERY_ATTEMPTS = 2;

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
 * the optional System.Number liveness read. Aborted on our own timeout so a
 * stuck host-side chainHead operation cannot hang the caller forever.
 */
async function queryOnce(
  address: string,
  includeCurrentBlock: boolean,
): Promise<AuthorizationStorageResult> {
  const { api } = await getBulletin();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, DIRECT_QUERY_TIMEOUT_MS);
  try {
    const [authorization, currentBlock] = await Promise.all([
      api.query.TransactionStorage.Authorizations.getValue(
        Enum("Account", address),
        { signal: controller.signal },
      ) as Promise<AuthorizationRecord | undefined>,
      includeCurrentBlock
        ? (api.query.System.Number.getValue({
            signal: controller.signal,
          }) as Promise<number>)
        : Promise.resolve(undefined),
    ]);
    return { authorization, currentBlock };
  } catch (error) {
    // PAPI rejects an aborted query with its own generic AbortError, whose
    // message ("Abort Error") does not describe what happened and cannot be
    // recognized by recovery.ts's stale-transport detection. Replace it with
    // our own message so both the UI and the recovery path see a clear,
    // matchable cause instead of a silent dead end.
    if (timedOut) {
      throw new Error(
        `Bulletin authorization query timed out after ${DIRECT_QUERY_TIMEOUT_MS}ms.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function queryAccountAuthorization(
  address: string,
  includeCurrentBlock: boolean,
): Promise<AuthorizationStorageResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= DIRECT_QUERY_ATTEMPTS; attempt += 1) {
    try {
      return await queryOnce(address, includeCurrentBlock);
    } catch (error) {
      lastError = error;
      console.warn("[soverstore:bulletin] Direct lookup attempt failed", {
        address,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Direct Bulletin lookup failed.");
}
