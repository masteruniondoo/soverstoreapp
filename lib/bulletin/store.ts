import {
  BulletinError,
  BulletinPreparer,
  ErrorCode,
  estimateAuthorization,
} from "@parity/bulletin-sdk";
import {
  submitAndWatch,
  type SubmittableTransaction,
  type TxResult,
  type TxStatus,
} from "@parity/product-sdk-tx";
import type { PolkadotSigner } from "polkadot-api";
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

    for (const chunk of prepared.chunks) {
      const label = `Chunk ${chunk.index + 1} of ${chunk.totalChunks}`;
      await submitStoreTransaction(
        api.tx.TransactionStorage.store({ data: chunk.data }),
        signer,
        label,
        onProgress,
        maxCallData,
        "best-block",
        walletLabel,
        chunk.index,
      );
    }

    if (!prepared.manifest) {
      throw new Error("Chunked upload was prepared without a file manifest.");
    }

    const manifestReceipt = await submitStoreTransaction(
      api.tx.TransactionStorage.store_with_cid_config({
        cid: {
          codec: 112n,
          hashing: { type: "Blake2b256" },
        },
        data: prepared.manifest.data,
      }),
      signer,
      "File manifest",
      onProgress,
      maxCallData,
      "finalized",
      walletLabel,
      prepared.chunks.length,
    );

    onProgress("File upload completed.");
    return {
      cid: prepared.manifest.cid.toString(),
      blockNumber: manifestReceipt.block.number,
      extrinsicIndex: manifestReceipt.block.index,
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
