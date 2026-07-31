import {
  AsyncBulletinClient,
  ChunkStatus,
  TxStatus,
  WaitFor,
  type ProgressEvent,
  type StoreResult,
} from "@parity/bulletin-sdk";
import type { PolkadotSigner } from "polkadot-api/pjs-signer";
import { getBulletin } from "./client";

/**
 * Desktop/mobile Host API messages must stay comfortably below the transport
 * limit. Bulletin defaults to 1 MiB chunks (and up to 2 MiB in one tx), which
 * is too large once the signed transaction envelope is added.
 */
const HOST_SAFE_CHUNK_SIZE = 256 * 1024;

export type BlobStoreResult = {
  cid: string;
  blockNumber?: number;
  extrinsicIndex?: number;
  size: number;
};

export async function storeBlob(
  data: Uint8Array,
  signer: PolkadotSigner,
  onProgress: (message: string) => void,
): Promise<BlobStoreResult> {
  if (data.length === 0) {
    throw new Error("Cannot upload an empty blob.");
  }

  const { api, client } = await getBulletin();
  const sdk = new AsyncBulletinClient(api, signer, client.submit);

  onProgress(`Preparing upload (${data.length} bytes)...`);
  const result: StoreResult = await sdk
    .store(data)
    .withChunkSize(HOST_SAFE_CHUNK_SIZE)
    .withCallback((event: ProgressEvent) => {
      switch (event.type) {
        case TxStatus.Signed:
          onProgress("Upload transaction signed...");
          break;
        case TxStatus.Broadcasted:
          onProgress("Broadcasting upload...");
          break;
        case TxStatus.InBlock:
          onProgress(
            `Upload included in block #${(event as { blockNumber?: number }).blockNumber ?? "..."}`,
          );
          break;
        case TxStatus.Finalized:
          onProgress("Upload finalized.");
          break;
        case ChunkStatus.ChunkStarted:
          onProgress(
            `Uploading chunk ${event.index + 1} of ${event.total}...`,
          );
          break;
        case ChunkStatus.ChunkCompleted:
          onProgress(`Chunk ${event.index + 1} of ${event.total} stored.`);
          break;
        case ChunkStatus.ManifestStarted:
          onProgress("Creating file manifest...");
          break;
        case ChunkStatus.ManifestCreated:
          onProgress("File manifest stored.");
          break;
        case ChunkStatus.Completed:
          onProgress("File upload completed.");
          break;
      }
    })
    .withWaitFor(WaitFor.Finalized)
    .send();

  const cid = result.cid?.toString();
  if (!cid) {
    throw new Error("Bulletin stored the blob but did not return a CID.");
  }

  return {
    cid,
    blockNumber: result.blockNumber,
    extrinsicIndex: result.extrinsicIndex,
    size: result.size,
  };
}

export const storeFile = storeBlob;
