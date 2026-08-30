import { Enum } from "polkadot-api";
import { getBulletin, resetBulletin } from "./client";
import { DIRECT_QUERY_TIMEOUT_MS, runHostQuery, withHostTimeout } from "./host-query";

type AuthorizationRecord = {
  extent?: {
    transactions?: string | number | bigint;
    transactions_allowance?: string | number | bigint;
    bytes?: string | number | bigint;
    bytes_allowance?: string | number | bigint;
  };
  expiration?: string | number | bigint | null;
};

export type AuthorizationStorageResult = {
  authorization?: AuthorizationRecord;
  currentBlock?: number;
};

/**
 * One direct TransactionStorage.Authorizations(Account(address)) read via the
 * host-routed PAPI client (the same client store.ts uses for uploads), plus
 * the optional System.Number liveness read.
 */
async function queryOnce(
  address: string,
  includeCurrentBlock: boolean,
): Promise<AuthorizationStorageResult> {
  const { api } = await withHostTimeout(
    getBulletin(),
    DIRECT_QUERY_TIMEOUT_MS,
    "the Bulletin chain client",
  );
  const authorization = await withHostTimeout(
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
  const currentBlock = await withHostTimeout(
    api.query.System.Number.getValue() as Promise<number>,
    DIRECT_QUERY_TIMEOUT_MS,
    "the current Bulletin block",
  );
  return { authorization, currentBlock };
}

export function queryAccountAuthorization(
  address: string,
  includeCurrentBlock: boolean,
): Promise<AuthorizationStorageResult> {
  return runHostQuery(
    () => queryOnce(address, includeCurrentBlock),
    resetBulletin,
    "Direct lookup",
  );
}
