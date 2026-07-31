import {
  AsyncBulletinClient,
  TxStatus,
  WaitFor,
  type ProgressEvent,
} from "@parity/bulletin-sdk";
import { SignerManager } from "@parity/product-sdk/wallet";
import { getBulletin } from "./client";

/** The allowance this app requests: 100 transactions, 10 MB. */
export const GRANT_TRANSACTIONS = 100;
export const GRANT_BYTES = 10n * 1024n * 1024n;

export interface Allowance {
  remainingTransactions: bigint;
  remainingBytes: bigint;
  expiresAtBlock?: number;
  /** True when the finalized block has reached the expiration block. */
  expired: boolean;
}

type AuthorizationRecord = {
  extent?: {
    transactions?: string | number | bigint;
    transactions_allowance?: string | number | bigint;
    bytes?: string | number | bigint;
    bytes_allowance?: string | number | bigint;
  };
  expiration?: number;
};

/**
 * Newer runtimes report a cap (`*_allowance`) next to consumed counters;
 * older ones report the remainder directly. Handle both.
 */
function remaining(used: unknown, allowance: unknown): bigint {
  if (allowance != null) {
    const cap = BigInt(allowance as string | number | bigint);
    const spent = BigInt((used as string | number | bigint) ?? 0);
    return cap > spent ? cap - spent : 0n;
  }
  return BigInt((used as string | number | bigint) ?? 0);
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
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

function normalizeAuthorization(value: unknown): AuthorizationRecord | null {
  if (value == null) return null;

  const option = value as {
    isNone?: boolean;
    isSome?: boolean;
    unwrap?: () => unknown;
    toJSON?: () => unknown;
  };

  if (option.isNone) return null;
  if (option.isSome && typeof option.unwrap === "function") {
    return normalizeAuthorization(option.unwrap());
  }
  if (typeof option.toJSON === "function") {
    return normalizeAuthorization(option.toJSON());
  }

  return value as AuthorizationRecord;
}

async function readAuthorization(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api: any,
  address: string,
): Promise<AuthorizationRecord | null> {
  const query = api.query as any;

  if (typeof query?.transactionStorage?.authorizations === "function") {
    const authorization = await query.transactionStorage.authorizations({
      account: address,
    });
    return normalizeAuthorization(authorization);
  }

  const authorization =
    await query.TransactionStorage.Authorizations.getValue({
      type: "Account",
      value: address,
    });
  return normalizeAuthorization(authorization);
}

/**
 * Reads `transactionStorage.authorizations` for the account. Returns `null`
 * when the account holds no authorization on the Bulletin Chain.
 */
export async function fetchAllowance(
  address: string,
): Promise<Allowance | null> {
  const { api, client } = await getBulletin();
  const auth = await withTimeout(
    readAuthorization(api, address),
    10_000,
    "Authorization check",
  );
  if (auth == null) return null;
  const extent = auth.extent ?? {};
  const expiresAtBlock: number | undefined = auth.expiration ?? undefined;
  const finalized =
    expiresAtBlock == null
      ? null
      : await withTimeout(
          client.getFinalizedBlock(),
          8_000,
          "Block check",
        ).catch(() => null);
  return {
    remainingTransactions: remaining(
      extent.transactions,
      extent.transactions_allowance,
    ),
    remainingBytes: remaining(extent.bytes, extent.bytes_allowance),
    expiresAtBlock,
    expired:
      expiresAtBlock != null &&
      finalized != null &&
      finalized.number >= expiresAtBlock,
  };
}

/**
 * Requests a storage allowance for `address` from the TestNet faucet.
 *
 * The Bulletin Chain has no balances: storage access is granted through
 * `transactionStorage.authorize_account`, which only registered authorizers
 * may call. On the Paseo TestNet the well-known dev account `//Eve` is such
 * an authorizer, matching the official Bulletin Console. TestNet only.
 */
export async function requestAllowance(
  address: string,
  onProgress: (message: string) => void,
): Promise<void> {
  onProgress("Preparing faucet signer...");
  const faucetManager = new SignerManager({ persistence: null });
  const connected = await faucetManager.connect("dev");
  if (!connected.ok) throw connected.error;

  const faucet = connected.value.find((account) => account.name === "Eve");
  if (!faucet) throw new Error("Devnet faucet account Eve is unavailable.");

  const selected = faucetManager.selectAccount(faucet.address);
  if (!selected.ok) throw selected.error;

  const faucetSigner = faucetManager.getSigner();
  if (!faucetSigner) throw new Error("Devnet faucet signer is unavailable.");

  const { api, client } = await getBulletin();
  const sdk = new AsyncBulletinClient(api, faucetSigner, client.submit);

  onProgress("Submitting authorization...");
  await sdk
    .authorizeAccount(address, GRANT_TRANSACTIONS, GRANT_BYTES)
    .withCallback((event: ProgressEvent) => {
      switch (event.type) {
        case TxStatus.Signed:
          onProgress("Transaction signed...");
          break;
        case TxStatus.Broadcasted:
          onProgress("Broadcasting to the network...");
          break;
        case TxStatus.InBlock:
          onProgress(
            `Included in block #${(event as { blockNumber?: number }).blockNumber ?? "..."}`,
          );
          break;
        case TxStatus.Finalized:
          onProgress("Finalized");
          break;
      }
    })
    .withWaitFor(WaitFor.Finalized)
    .send();
}
