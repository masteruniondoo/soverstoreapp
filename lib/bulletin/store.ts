import {
  BulletinError,
  BulletinPreparer,
  ErrorCode,
  estimateAuthorization,
} from "@parity/bulletin-sdk";
import {
  submitAndWatch,
  type SubmittableTransaction,
  type TxEvent,
  type TxResult,
  type TxStatus,
} from "@parity/product-sdk-tx";
import type { PolkadotSigner } from "polkadot-api";
import { ss58Encode } from "@parity/product-sdk-address";
import { ensureTransactionSigningPermission } from "@/lib/wallet";
import { detectSoverStoreRuntime } from "@/lib/runtime/soverstore-runtime";
import { getBulletin } from "./client";
import { signingLimits, NATIVE_HOST_CHUNK_SIZE } from "./signing-limits";

// How large a chunk may be depends on which wallet transport answers the
// signing request, so it is resolved per upload: see ./signing-limits.
const UPLOAD_TX_TIMEOUT_MS = 180_000;
const MOBILE_APPROVAL_REMINDER_MS = 12_000;
const MOBILE_APPROVAL_DIAGNOSTIC_MS = 45_000;
const MOBILE_APPROVAL_TIMEOUT_MS = 75_000;

/**
 * What to say when a signing request is never answered.
 *
 * Names the wallet that was actually asked, and the one thing that is known to
 * clear it: the wallet session goes quiet partway through a multi-chunk upload
 * and stays quiet for later uploads too, so reopening the wallet is what gets
 * signing working again. Nothing in this app can restart it from here.
 */
export class WalletSilentError extends Error {
  readonly code = "WALLET_DID_NOT_ANSWER";

  constructor(message: string) {
    super(message);
    this.name = "WalletSilentError";
  }
}

function approvalTimeoutMessage(wallet: string, signedSoFar: number): string {
  const progress =
    signedSoFar > 0
      ? ` The first ${signedSoFar} of this upload's requests were signed normally, so this is the wallet session going quiet rather than the request being refused.`
      : "";
  return (
    `${wallet} did not answer the signing request within 75 seconds.${progress}` +
    ` Reopen the Polkadot app on your phone - and reconnect it here if it asks - then upload again.` +
    ` The file was not uploaded.`
  );
}

function storeFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.toLowerCase().includes("no allowance set for account")) {
    return "Polkadot Desktop could not deliver the signing request because its device Statement Store allowance is missing. Open your Desktop profile, choose Log Out, pair the phone again by QR, then reopen SoverStore and retry. The file was not uploaded.";
  }
  return message;
}

export type BlobStoreResult = {
  cid: string;
  blockNumber?: number;
  extrinsicIndex?: number;
  size: number;
};

export type StoreAuthorization = {
  transactions: bigint;
  bytes: bigint;
};

/**
 * Mirrors the chunk and manifest configuration used by storeBlob.
 *
 * Takes the chunk size rather than detecting the runtime, so an estimate can
 * never describe a different upload than the one that will run.
 */
export function estimateStoreAuthorization(
  dataSize: number,
  chunkSize: number = NATIVE_HOST_CHUNK_SIZE,
): StoreAuthorization {
  if (dataSize <= chunkSize) {
    return { transactions: 1n, bytes: BigInt(dataSize) };
  }
  const required = estimateAuthorization(dataSize, chunkSize, true);
  return {
    transactions: BigInt(required.transactions),
    bytes: BigInt(required.bytes),
  };
}

export function progressSigner(
  signer: PolkadotSigner,
  label: string,
  onProgress: (message: string) => void,
  maxCallData: number = NATIVE_HOST_CHUNK_SIZE * 2,
  wallet = "The wallet",
  signedSoFar = 0,
): PolkadotSigner {
  return {
    publicKey: signer.publicKey,
    signBytes: (data) => signer.signBytes(data),
    signTx: (callData, signedExtensions, metadata, atBlockNumber, hasher) => {
      if (callData.length > maxCallData) {
        return Promise.reject(
          new Error(
            `${label} signing payload is too large for the mobile wallet transport (${callData.length} bytes).`,
          ),
        );
      }
      // This is the exact point at which PAPI calls the Desktop/mobile signer.
      onProgress(`${label}: signing request sent. Approve it in ${wallet}...`);
      const reminder = setTimeout(() => {
        onProgress(`${label}: still waiting for approval in ${wallet}...`);
      }, MOBILE_APPROVAL_REMINDER_MS);
      const diagnostic = setTimeout(() => {
        onProgress(
          `${label}: ${wallet} has not answered yet. If no request is visible there, it did not arrive...`,
        );
      }, MOBILE_APPROVAL_DIAGNOSTIC_MS);

      const signing = Promise.resolve().then(() =>
        signer.signTx(
          callData,
          signedExtensions,
          metadata,
          atBlockNumber,
          hasher,
        ),
      );
      let approvalTimeout: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        approvalTimeout = setTimeout(
          () =>
            reject(
              new WalletSilentError(approvalTimeoutMessage(wallet, signedSoFar)),
            ),
          MOBILE_APPROVAL_TIMEOUT_MS,
        );
      });

      return Promise.race([signing, timeout]).finally(() => {
        clearTimeout(reminder);
        clearTimeout(diagnostic);
        if (approvalTimeout !== undefined) clearTimeout(approvalTimeout);
      });
    },
  };
}

function statusMessage(label: string, status: TxStatus): string {
  switch (status) {
    case "signing":
      return `${label}: transaction signed.`;
    case "broadcasting":
      return `${label}: broadcasting to Bulletin...`;
    case "in-block":
      return `${label}: included in a block; waiting for finalization...`;
    case "finalized":
      return `${label}: finalized.`;
    case "error":
      return `${label}: transaction failed.`;
  }
}

/**
 * How long to hold an upload before moving to the next transaction.
 *
 * Bulletin finality trails the best block by 3-6 blocks - roughly 26-52
 * seconds at its ~8.7s block time - so waiting for it on every chunk turned a
 * nine-chunk upload into five to eight minutes, with the user's phone asked to
 * approve a request at each step. That long window is where uploads were
 * dying: the pairing appears to go stale partway through, after which no
 * further signing request is answered.
 *
 * Chunks therefore continue once they are in a block, and only the last
 * transaction - the manifest, the one that names the file - waits for
 * finality. The risk this accepts is a reorg dropping an already-accepted
 * chunk out from under a finalized manifest, within the 3-6 block window
 * measured above. Weighed against an upload that reliably fails partway, the
 * shorter run is the better trade, and the manifest still anchors the result.
 */
type UploadWait = "best-block" | "finalized";

async function submitStoreTransaction(
  tx: SubmittableTransaction,
  signer: PolkadotSigner,
  label: string,
  onProgress: (message: string) => void,
  maxCallData: number,
  waitFor: UploadWait,
  wallet: string,
  signedSoFar: number,
): Promise<TxResult> {
  onProgress(`${label}: preparing wallet request...`);
  const result = await submitAndWatch(
    tx,
    progressSigner(signer, label, onProgress, maxCallData, wallet, signedSoFar),
    {
      waitFor,
      timeoutMs: UPLOAD_TX_TIMEOUT_MS,
      mortalityPeriod: 256,
      onStatus: (status) => onProgress(statusMessage(label, status)),
    },
  );

  if (!result.ok) throw result.error;
  return result.value;
}

/**
 * One chunk, signed now and confirmed later.
 *
 * The wallet is asked for a signature and the transaction is broadcast, but
 * nothing here waits for a block: `signed` resolves the moment the wallet has
 * answered, so the next chunk's request can go out immediately, while
 * `included` keeps tracking this one in the background.
 *
 * That separation is the point. Waiting for each chunk to be confirmed before
 * asking for the next signature left the user approving, waiting half a
 * minute, approving again - minutes of a pairing that has to stay alive
 * throughout, which is where uploads were dying. Signing straight through
 * takes as long as the user needs to tap, and the confirmations overlap.
 *
 * Every request carries its own explicit nonce. PAPI otherwise reads the nonce
 * from the finalized block, so overlapping transactions would all claim the
 * same one and only the first would ever be accepted.
 */
/**
 * What this module needs of a transaction, which is what PAPI actually
 * provides: the SDK's own `SubmittableTransaction` narrows the options to
 * `mortality`, and overlapping uploads have to set their nonce explicitly.
 */
type NonceControlledTransaction = {
  signSubmitAndWatch: (
    signer: PolkadotSigner,
    options?: {
      nonce?: number;
      mortality?: { mortal: boolean; period: number };
    },
  ) => {
    subscribe: (handlers: {
      next: (event: TxEvent) => void;
      error: (error: Error) => void;
    }) => { unsubscribe: () => void };
  };
};

type BlockLocation = { number: number; index: number };

/**
 * Transaction subscriptions belonging to the upload currently running.
 *
 * An upload that is abandoned partway leaves signed chunks still being
 * tracked. Nobody is waiting on them any more, but they keep the chain client
 * busy and their eventual failures arrive as rejections no one handles, so the
 * next upload starts on top of the previous one's wreckage. Cancelling them is
 * part of starting over.
 */
const activeSubscriptions = new Set<{ unsubscribe: () => void }>();

/** Stops tracking every transaction from an upload that is being abandoned. */
export function abortActiveUploads(): void {
  for (const subscription of [...activeSubscriptions]) {
    activeSubscriptions.delete(subscription);
    try {
      subscription.unsubscribe();
    } catch {
      // An already-closed subscription is exactly what we wanted.
    }
  }
}

type TrackedChunk = {
  /** Resolves once the wallet has answered this request. */
  signed: Promise<void>;
  /** Resolves, with where it landed, once the transaction has reached the
   *  block state the caller asked for. */
  included: Promise<BlockLocation>;
};

function signAndTrack(
  tx: NonceControlledTransaction,
  signer: PolkadotSigner,
  options: {
    nonce: number;
    label: string;
    onProgress: (message: string) => void;
    maxCallData: number;
    wallet: string;
    signedSoFar: number;
    /** A chunk owes nothing beyond inclusion; the manifest, which names them
     *  all, is the one transaction worth waiting on for finality. */
    waitFor: UploadWait;
  },
): TrackedChunk {
  const { label, onProgress } = options;

  let resolveSigned!: () => void;
  let rejectSigned!: (error: unknown) => void;
  const signed = new Promise<void>((resolve, reject) => {
    resolveSigned = resolve;
    rejectSigned = reject;
  });

  let resolveIncluded!: (location: BlockLocation) => void;
  let rejectIncluded!: (error: unknown) => void;
  const included = new Promise<BlockLocation>((resolve, reject) => {
    resolveIncluded = resolve;
    rejectIncluded = reject;
  });
  // A rejection is always attached below, but `signed` may be handed back
  // before the caller awaits `included`; without this, a failure in between
  // surfaces as an unhandled rejection.
  included.catch(() => undefined);

  onProgress(`${label}: preparing wallet request...`);
  const forget = () => {
    activeSubscriptions.delete(subscription);
  };
  const subscription = tx
    .signSubmitAndWatch(
      progressSigner(
        signer,
        label,
        onProgress,
        options.maxCallData,
        options.wallet,
        options.signedSoFar,
      ),
      { nonce: options.nonce, mortality: { mortal: true, period: 256 } },
    )
    .subscribe({
      next: (event) => {
        switch (event.type) {
          case "signed":
            onProgress(`${label}: signed.`);
            resolveSigned();
            break;
          case "broadcasted":
            onProgress(`${label}: broadcasting to Bulletin...`);
            break;
          case "txBestBlocksState":
            if (!event.found) return;
            if (!event.ok) {
              rejectIncluded(
                new Error(
                  `${label} failed on Bulletin: ${JSON.stringify(event.dispatchError)}`,
                ),
              );
              subscription.unsubscribe();
              return;
            }
            onProgress(
              options.waitFor === "finalized"
                ? // Bulletin finality trails the best block by 3-6 blocks, so
                  // this is a real wait and saying so beats a silent screen
                  // while the recovery artifacts are held back.
                  `${label}: included in a block; waiting for finalization, usually under a minute...`
                : `${label}: included in a block.`,
            );
            if (options.waitFor === "best-block") {
              if (!event.block) {
                rejectIncluded(
                  new Error(`${label} was included without reporting its block.`),
                );
                subscription.unsubscribe();
                return;
              }
              resolveIncluded({
                number: event.block.number,
                index: event.block.index,
              });
              forget();
              subscription.unsubscribe();
            }
            break;
          case "finalized":
            if (!event.ok) {
              rejectIncluded(
                new Error(
                  `${label} failed on Bulletin: ${JSON.stringify(event.dispatchError)}`,
                ),
              );
              return;
            }
            onProgress(`${label}: finalized.`);
            if (!event.block) {
              rejectIncluded(
                new Error(`${label} finalized without reporting its block.`),
              );
              return;
            }
            resolveIncluded({
              number: event.block.number,
              index: event.block.index,
            });
            forget();
            break;
        }
      },
      error: (error: unknown) => {
        forget();
        rejectSigned(error);
        rejectIncluded(error);
      },
    });

  activeSubscriptions.add(subscription);
  return { signed, included };
}

export async function storeBlob(
  data: Uint8Array,
  signer: PolkadotSigner,
  onProgress: (message: string) => void,
): Promise<BlobStoreResult> {
  if (data.length === 0) {
    throw new Error("Cannot upload an empty blob.");
  }

  const { api } = await getBulletin();
  // Which wallet answers the signing request decides how much may travel in
  // one: a QR-paired phone cannot carry what Desktop can.
  const { chunkSize, maxCallData, walletLabel } = signingLimits(
    await detectSoverStoreRuntime(),
  );
  const preparer = new BulletinPreparer({
    defaultChunkSize: chunkSize,
    chunkingThreshold: chunkSize,
    createManifest: true,
  });

  try {
    onProgress(`Preparing upload (${data.length} bytes)...`);
    onProgress("Confirming wallet signing permission...");
    await ensureTransactionSigningPermission();

    if (data.length <= chunkSize) {
      const prepared = await preparer.prepareStore(data);
      const receipt = await submitStoreTransaction(
        api.tx.TransactionStorage.store({ data: prepared.data }),
        signer,
        "Upload",
        onProgress,
        maxCallData,
        "finalized",
        walletLabel,
        0,
      );

      return {
        cid: prepared.cid.toString(),
        blockNumber: receipt.block.number,
        extrinsicIndex: receipt.block.index,
        size: data.length,
      };
    }

    const prepared = await preparer.prepareStoreChunked(data, {
      chunkSize,
      createManifest: true,
    });

    // Each request carries its own nonce, counted up from the account's
    // current one, because several of them are in flight at once and PAPI
    // would otherwise read the same nonce from the finalized block for all.
    const address = ss58Encode(signer.publicKey);
    const account = (await api.query.System.Account.getValue(address, {
      at: "best",
    })) as { nonce: number };
    let nonce = Number(account.nonce);

    const confirmations: Promise<BlockLocation>[] = [];
    for (const chunk of prepared.chunks) {
      const label = `Chunk ${chunk.index + 1} of ${chunk.totalChunks}`;
      const tracked = signAndTrack(
        api.tx.TransactionStorage.store({
          data: chunk.data,
        }) as NonceControlledTransaction,
        signer,
        {
          nonce: nonce++,
          label,
          onProgress,
          maxCallData,
          wallet: walletLabel,
          signedSoFar: chunk.index,
          waitFor: "best-block",
        },
      );
      confirmations.push(tracked.included);
      // Only the signature is waited for: the user signs straight through
      // while the chunks already signed make their way into blocks.
      await tracked.signed;
    }

    if (!prepared.manifest) {
      throw new Error("Chunked upload was prepared without a file manifest.");
    }

    // The manifest names the chunks, so it must not be signed until they are
    // all actually in blocks.
    onProgress(
      `All ${prepared.chunks.length} chunks signed. Waiting for them to reach Bulletin...`,
    );
    await Promise.all(confirmations);

    const manifest = signAndTrack(
      api.tx.TransactionStorage.store_with_cid_config({
        cid: {
          codec: 112n,
          hashing: { type: "Blake2b256" },
        },
        data: prepared.manifest.data,
      }) as NonceControlledTransaction,
      signer,
      {
        // Continues the same count: the chunks above are in blocks but not yet
        // finalized, so the chain's own nonce still lags behind them.
        nonce: nonce++,
        label: "File manifest",
        onProgress,
        maxCallData,
        wallet: walletLabel,
        signedSoFar: prepared.chunks.length,
        waitFor: "finalized",
      },
    );
    await manifest.signed;
    const manifestBlock = await manifest.included;

    onProgress("File upload completed.");
    return {
      cid: prepared.manifest.cid.toString(),
      blockNumber: manifestBlock.number,
      extrinsicIndex: manifestBlock.index,
      size: data.length,
    };
  } catch (error) {
    if (error instanceof BulletinError) throw error;
    // Already says what happened and what to do; wrapping it would append a
    // recovery hint about transaction parameters and nonces, which is a false
    // lead when the wallet simply never answered.
    if (error instanceof WalletSilentError) throw error;
    throw new BulletinError(
      storeFailureMessage(error),
      ErrorCode.TRANSACTION_FAILED,
      error,
    );
  }
}

export const storeFile = storeBlob;
