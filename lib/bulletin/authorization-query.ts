import { Enum } from "polkadot-api";
import { getAuthorizationsApi, getBulletin, resetBulletin } from "./client";
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
 * Read at the best block rather than PAPI's default finalized one.
 *
 * Measured on Devnet Bulletin: ~8.7s blocks, with finality running 3-6 blocks
 * (roughly 26-52 seconds) behind the best block. An authorization is therefore
 * present in chain state for the better part of a minute before a finalized
 * read can see it, which is what made a just-granted authorization look
 * missing until the page was reloaded.
 *
 * The reorg risk this accepts is one stale read that the next lookup corrects;
 * the chain, not this value, is what actually gates an upload.
 *
 * `at` is a plain PAPI storage option, but this client is host-routed and the
 * Desktop transport has surprised this codebase before, so an unsupported
 * option falls back to the default view instead of failing the whole read.
 */
async function readAtBestBlock<T>(
  read: (options?: { at: string }) => Promise<unknown>,
): Promise<T> {
  try {
    return (await read({ at: "best" })) as T;
  } catch (error) {
    console.warn(
      "[soverstore:bulletin] Best-block read rejected; falling back to the finalized view",
      { error: error instanceof Error ? error.message : String(error) },
    );
    return (await read()) as T;
  }
}

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
  // Read through the descriptor whose Authorizations type matches the runtime
  // this chain now runs; see getAuthorizationsApi for why devnet_bulletin
  // cannot decode this one entry.
  const authorizationsApi = await withHostTimeout(
    getAuthorizationsApi(),
    DIRECT_QUERY_TIMEOUT_MS,
    "the Bulletin chain client",
  );
  const authorization = await withHostTimeout(
    readAtBestBlock<AuthorizationRecord | undefined>((options) =>
      authorizationsApi.query.TransactionStorage.Authorizations.getValue(
        Enum("Account", address),
        options,
      ),
    ),
    DIRECT_QUERY_TIMEOUT_MS,
    "the account authorization",
  );
  if (!includeCurrentBlock || !authorization) return { authorization };

  // Read liveness only when the caller needs it and an authorization exists.
  // This keeps the ordinary connect-time Lookup Account path to one storage
  // read and gives each required value its own clear timeout stage.
  // Read the head from the same view as the authorization above, so an
  // expiry comparison never straddles two different blocks.
  const currentBlock = await withHostTimeout(
    readAtBestBlock<number>((options) =>
      api.query.System.Number.getValue(options),
    ),
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
