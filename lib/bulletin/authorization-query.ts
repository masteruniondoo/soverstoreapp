import { formatHostError, getTruApi } from "@parity/product-sdk/host";
import { devnet_bulletin } from "@parity/product-sdk-descriptors/devnet-bulletin";
import {
  createClient as createTruApiClient,
  createTransport,
  type TrUApiClient,
  type WireProvider,
} from "@parity/truapi";
import { blake2AsU8a, xxhashAsU8a } from "@polkadot/util-crypto";
import { Binary, Enum, getTypedCodecs } from "polkadot-api";

const DIRECT_QUERY_TIMEOUT_MS = 6_000;
const DIRECT_QUERY_ATTEMPTS = 2;
const bulletinCodecsPromise = getTypedCodecs(devnet_bulletin);
const descriptorGenesis = devnet_bulletin.genesis;
if (!descriptorGenesis) {
  throw new Error("Devnet Bulletin descriptor has no genesis hash.");
}
type HostHex = `0x${string}`;
const bulletinGenesis = descriptorGenesis as HostHex;

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

type StorageItem = {
  key: HostHex;
  value?: HostHex;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  settled: () => boolean;
};

function deferred<T>(): Deferred<T> {
  let done = false;
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value) {
      if (done) return;
      done = true;
      resolvePromise(value);
    },
    reject(error) {
      if (done) return;
      done = true;
      rejectPromise(error);
    },
    settled: () => done,
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  stage: () => string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `Direct Bulletin lookup timed out after ${ms}ms while waiting for ${stage()}`,
          ),
        ),
      ms,
    );
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

type HostClient = {
  client: TrUApiClient;
  dispose: () => void;
  fresh: boolean;
};

/**
 * Reuses the SDK's cached sandbox client. Note: that cache is built once for
 * the whole document and never refreshed, so once a wallet has connected it
 * can keep pointing at a MessagePort Desktop has since replaced -- this is
 * only a safe fallback for when no live port is available at all.
 */
async function createCachedHostClient(): Promise<HostClient> {
  const client = await getTruApi();
  if (!client) throw new Error("Polkadot Desktop host API is unavailable.");
  return { client, fresh: false, dispose: () => undefined };
}

/**
 * Builds an isolated TruAPI transport over Desktop's current MessagePort.
 * The SDK's sandbox client is intentionally cached for the whole document;
 * after wallet connection that cache can retain a pre-login transport until a
 * manual refresh. A second listener on the same current port gets fresh request
 * and subscription state without replacing or closing the shared port.
 */
async function createLookupHostClient(): Promise<HostClient> {
  if (typeof window !== "undefined") {
    const hostWindow = window as Window & {
      __HOST_API_PORT__?: MessagePort;
    };
    const port = hostWindow.__HOST_API_PORT__;
    if (port) {
      const listeners = new Set<(message: Uint8Array) => void>();
      const onMessage = (event: MessageEvent<unknown>) => {
        if (event.data instanceof Uint8Array) {
          for (const listener of [...listeners]) listener(event.data);
        }
      };
      port.addEventListener("message", onMessage);
      port.start();
      const provider: WireProvider = {
        postMessage(message) {
          port.postMessage(message);
        },
        subscribe(callback) {
          listeners.add(callback);
          return () => listeners.delete(callback);
        },
        dispose() {
          port.removeEventListener("message", onMessage);
          listeners.clear();
        },
      };
      const transport = createTransport(provider);
      return {
        client: createTruApiClient(transport),
        fresh: true,
        dispose() {
          transport.dispose();
          provider.dispose();
        },
      };
    }
  }

  return createCachedHostClient();
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((total, part) => total + part.length, 0);
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.length;
  }
  return combined;
}

function storagePrefix(pallet: string, item: string): Uint8Array {
  return concatBytes([
    xxhashAsU8a(pallet, 128),
    xxhashAsU8a(item, 128),
  ]);
}

async function storageKeys(address: string, includeCurrentBlock: boolean) {
  const codecs = await bulletinCodecsPromise;
  const scopeCodec = codecs.query.TransactionStorage.Authorizations.args.inner[0];
  const encodedScope = scopeCodec.enc(Enum("Account", address));
  const authorizationKey = Binary.toHex(
    concatBytes([
      storagePrefix("TransactionStorage", "Authorizations"),
      blake2AsU8a(encodedScope, 128),
      encodedScope,
    ]),
  ) as HostHex;
  const currentBlockKey = includeCurrentBlock
    ? (Binary.toHex(storagePrefix("System", "Number")) as HostHex)
    : undefined;
  return { codecs, authorizationKey, currentBlockKey };
}

type OperationState = {
  items: StorageItem[];
  completion: Deferred<void>;
};

/**
 * Reads finalized storage through the native host chain protocol. This avoids
 * the PAPI chainHead bridge, whose stop-operation command is not understood by
 * some Polkadot Desktop builds and can leave getValue() pending forever.
 */
async function queryFinalizedStorage(keys: HostHex[]): Promise<StorageItem[]> {
  const host = await createLookupHostClient();
  const truApi = host.client;
  let stage = "the finalized Bulletin head";

  const initialized = deferred<HostHex>();
  const operations = new Map<string, OperationState>();
  const getOperation = (operationId: string) => {
    let operation = operations.get(operationId);
    if (!operation) {
      operation = { items: [], completion: deferred<void>() };
      operations.set(operationId, operation);
    }
    return operation;
  };
  const failAll = (error: unknown) => {
    initialized.reject(error);
    for (const operation of operations.values()) {
      operation.completion.reject(error);
    }
  };

  const follow = truApi.chain.followHeadSubscribe({
    request: {
      genesisHash: bulletinGenesis,
      withRuntime: false,
    },
  });
  const subscription = follow.subscribe({
    next(item) {
      switch (item.tag) {
        case "Initialized": {
          const hash = item.value.finalizedBlockHashes.at(-1);
          if (hash) initialized.resolve(hash);
          else initialized.reject(new Error("Bulletin returned no finalized block."));
          break;
        }
        case "OperationStorageItems":
          getOperation(item.value.operationId).items.push(...item.value.items);
          break;
        case "OperationStorageDone":
          getOperation(item.value.operationId).completion.resolve();
          break;
        case "OperationInaccessible":
          getOperation(item.value.operationId).completion.reject(
            new Error("Bulletin storage is inaccessible at the finalized block."),
          );
          break;
        case "OperationError":
          getOperation(item.value.operationId).completion.reject(
            new Error(item.value.error),
          );
          break;
        case "OperationWaitingForContinue": {
          const operation = getOperation(item.value.operationId);
          void truApi.chain
            .continueHead({
              genesisHash: bulletinGenesis,
              followSubscriptionId: subscription.subscriptionId,
              operationId: item.value.operationId,
            })
            .then((result) => {
              if (result.isErr()) {
                operation.completion.reject(
                  new Error(`Bulletin continue failed: ${formatHostError(result.error)}`),
                );
              }
            });
          break;
        }
        case "Stop":
          failAll(new Error("Bulletin stopped the chain subscription."));
          break;
      }
    },
    error(error) {
      failAll(error);
    },
    complete() {
      failAll(new Error("Bulletin chain subscription ended before the lookup completed."));
    },
  });

  const lookup = (async () => {
    const finalizedHash = await initialized.promise;
    stage = "the Bulletin storage response";
    const result = await truApi.chain.getHeadStorage({
      genesisHash: bulletinGenesis,
      followSubscriptionId: subscription.subscriptionId,
      hash: finalizedHash,
      items: keys.map((key) => ({ key, queryType: "Value" as const })),
    });
    if (result.isErr()) {
      throw new Error(`Bulletin storage query failed: ${formatHostError(result.error)}`);
    }
    if (result.value.operation.tag !== "Started") {
      throw new Error("Bulletin storage operation limit was reached.");
    }
    stage = "the Bulletin storage value";
    const operation = getOperation(result.value.operation.value.operationId);
    await operation.completion.promise;
    return operation.items;
  })();

  try {
    return await withTimeout(lookup, DIRECT_QUERY_TIMEOUT_MS, () => stage);
  } finally {
    subscription.unsubscribe();
    host.dispose();
  }
}

export async function queryAccountAuthorization(
  address: string,
  includeCurrentBlock: boolean,
): Promise<AuthorizationStorageResult> {
  const { codecs, authorizationKey, currentBlockKey } = await storageKeys(
    address,
    includeCurrentBlock,
  );
  const keys = currentBlockKey
    ? [authorizationKey, currentBlockKey]
    : [authorizationKey];

  let lastError: unknown;
  for (let attempt = 1; attempt <= DIRECT_QUERY_ATTEMPTS; attempt += 1) {
    try {
      const items = await queryFinalizedStorage(keys);
      const byKey = new Map(items.map((item) => [item.key, item.value]));
      const rawAuthorization = byKey.get(authorizationKey);
      const rawCurrentBlock = currentBlockKey
        ? byKey.get(currentBlockKey)
        : undefined;
      return {
        authorization: rawAuthorization
          ? (codecs.query.TransactionStorage.Authorizations.value.dec(
              Binary.fromHex(rawAuthorization),
            ) as AuthorizationRecord)
          : undefined,
        currentBlock: rawCurrentBlock
          ? Number(
              codecs.query.System.Number.value.dec(Binary.fromHex(rawCurrentBlock)),
            )
          : undefined,
      };
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
