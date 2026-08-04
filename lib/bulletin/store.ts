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
import { getBulletin } from "./client";

/**
 * Desktop/mobile Host API messages must stay comfortably below the transport
 * limit. Bulletin defaults to 1 MiB chunks (and up to 2 MiB in one tx), which
 * is too large once the signed transaction envelope is added.
 */
// `createTransaction` transports callData as a hex string, so every raw byte
// occupies two bytes before the host/mobile envelope is added. 128 KiB keeps
// the complete signing request well below the Desktop-to-mobile size limit.
const HOST_SAFE_CHUNK_SIZE = 128 * 1024;
const MAX_HOST_CALL_DATA_SIZE = 160 * 1024;
const UPLOAD_TX_TIMEOUT_MS = 180_000;
const MOBILE_APPROVAL_REMINDER_MS = 12_000;
const MOBILE_APPROVAL_DIAGNOSTIC_MS = 45_000;
const MOBILE_APPROVAL_TIMEOUT_MS = 75_000;

const MOBILE_APPROVAL_TIMEOUT_MESSAGE =
  "Polkadot Desktop did not return a result from the signing request within 75 seconds. Its signing bridge may have blocked the request before it reached the mobile wallet. The file was not uploaded.";

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

/** Mirrors the exact chunk and manifest configuration used by storeBlob. */
export function estimateStoreAuthorization(dataSize: number): StoreAuthorization {
  if (dataSize <= HOST_SAFE_CHUNK_SIZE) {
    return { transactions: 1n, bytes: BigInt(dataSize) };
  }
  const required = estimateAuthorization(dataSize, HOST_SAFE_CHUNK_SIZE, true);
  return {
    transactions: BigInt(required.transactions),
    bytes: BigInt(required.bytes),
  };
}

function progressSigner(
  signer: PolkadotSigner,
  label: string,
  onProgress: (message: string) => void,
): PolkadotSigner {
  return {
    publicKey: signer.publicKey,
    signBytes: (data) => signer.signBytes(data),
    signTx: (callData, signedExtensions, metadata, atBlockNumber, hasher) => {
      if (callData.length > MAX_HOST_CALL_DATA_SIZE) {
        return Promise.reject(
          new Error(
            `${label} signing payload is too large for the mobile wallet transport (${callData.length} bytes).`,
          ),
        );
      }
      // This is the exact point at which PAPI calls the Desktop/mobile signer.
      onProgress(`${label}: signing request sent. Approve it in the mobile wallet...`);
      const reminder = setTimeout(() => {
        onProgress(`${label}: still waiting for mobile wallet approval...`);
      }, MOBILE_APPROVAL_REMINDER_MS);
      const diagnostic = setTimeout(() => {
        onProgress(
          `${label}: Polkadot Desktop has not returned a signing response. If no request is visible on the phone, the Desktop signing bridge did not deliver it...`,
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
          () => reject(new Error(MOBILE_APPROVAL_TIMEOUT_MESSAGE)),
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

async function submitStoreTransaction(
  tx: SubmittableTransaction,
  signer: PolkadotSigner,
  label: string,
  onProgress: (message: string) => void,
): Promise<TxResult> {
  onProgress(`${label}: preparing wallet request...`);
  const result = await submitAndWatch(tx, progressSigner(signer, label, onProgress), {
    waitFor: "finalized",
    timeoutMs: UPLOAD_TX_TIMEOUT_MS,
    mortalityPeriod: 256,
    onStatus: (status) => onProgress(statusMessage(label, status)),
  });

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
  const preparer = new BulletinPreparer({
    defaultChunkSize: HOST_SAFE_CHUNK_SIZE,
    chunkingThreshold: HOST_SAFE_CHUNK_SIZE,
    createManifest: true,
  });

  try {
    onProgress(`Preparing upload (${data.length} bytes)...`);
    onProgress("Confirming wallet signing permission...");
    await ensureTransactionSigningPermission();

    if (data.length <= HOST_SAFE_CHUNK_SIZE) {
      const prepared = await preparer.prepareStore(data);
      const receipt = await submitStoreTransaction(
        api.tx.TransactionStorage.store({ data: prepared.data }),
        signer,
        "Upload",
        onProgress,
      );

      return {
        cid: prepared.cid.toString(),
        blockNumber: receipt.block.number,
        extrinsicIndex: receipt.block.index,
        size: data.length,
      };
    }

    const prepared = await preparer.prepareStoreChunked(data, {
      chunkSize: HOST_SAFE_CHUNK_SIZE,
      createManifest: true,
    });

    for (const chunk of prepared.chunks) {
      const label = `Chunk ${chunk.index + 1} of ${chunk.totalChunks}`;
      await submitStoreTransaction(
        api.tx.TransactionStorage.store({ data: chunk.data }),
        signer,
        label,
        onProgress,
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
    throw new BulletinError(
      storeFailureMessage(error),
      ErrorCode.TRANSACTION_FAILED,
      error,
    );
  }
}

export const storeFile = storeBlob;
