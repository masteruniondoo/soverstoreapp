import { parseCid } from "@parity/bulletin-sdk";
import { Enum, type PolkadotSigner } from "polkadot-api";
import { submitAndWatch, type TxStatus } from "@parity/product-sdk-tx";
import { ensureTransactionSigningPermission } from "@/lib/wallet";
import { getBulletin, resetBulletin } from "./client";
import { DIRECT_QUERY_TIMEOUT_MS, runHostQuery, withHostTimeout } from "./host-query";
import { progressSigner } from "./store";

const RENEW_TX_TIMEOUT_MS = 180_000;

export type StoredDataLocation = {
  blockNumber: number;
  extrinsicIndex: number;
};

function toHex(bytes: Uint8Array): `0x${string}` {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `0x${hex}`;
}

/** Blocks a stored (ephemeral) transaction survives before it is dropped unless renewed. */
export function fetchRetentionPeriod(): Promise<number> {
  return runHostQuery(
    async () => {
      const { api } = await withHostTimeout(
        getBulletin(),
        DIRECT_QUERY_TIMEOUT_MS,
        "the Bulletin chain client",
      );
      const period = await withHostTimeout(
        api.query.TransactionStorage.RetentionPeriod.getValue(),
        DIRECT_QUERY_TIMEOUT_MS,
        "the retention period",
      );
      return Number(period);
    },
    resetBulletin,
    "Retention period lookup",
  );
}

export function fetchCurrentBulletinBlock(): Promise<number> {
  return runHostQuery(
    async () => {
      const { api } = await withHostTimeout(
        getBulletin(),
        DIRECT_QUERY_TIMEOUT_MS,
        "the Bulletin chain client",
      );
      const block = await withHostTimeout(
        api.query.System.Number.getValue(),
        DIRECT_QUERY_TIMEOUT_MS,
        "the current Bulletin block",
      );
      return Number(block);
    },
    resetBulletin,
    "Current block lookup",
  );
}

function statusMessage(status: TxStatus): string {
  switch (status) {
    case "signing":
      return "Renewal: transaction signed.";
    case "broadcasting":
      return "Renewal: broadcasting to Bulletin...";
    case "in-block":
      return "Renewal: included in a block; waiting for finalization...";
    case "finalized":
      return "Renewal: finalized.";
    case "error":
      return "Renewal: transaction failed.";
  }
}

/**
 * Immediately (synchronously) extends a previously stored transaction's
 * retention period via `TransactionStorage.force_renew`. Requires the same
 * active account authorization as `store`, and charges a normal transaction
 * fee plus the data's size against the caller's `bytes_permanent` allowance.
 *
 * Addresses the entry by content hash (derived from the CID) rather than
 * `(block, index)`: that position is the pallet's own internal slot within
 * `Transactions[block]`, not the extrinsic's position in the block, and the
 * client has no way to observe it -- passing the tx receipt's block index
 * there resolves to the wrong entry and the chain rejects it outright
 * (`InvalidTransaction::Custom(2)`, "Renewed extrinsic not found"). Content
 * hash has no such ambiguity and needs nothing beyond the CID.
 */
export async function renewStoredData(
  cid: string,
  signer: PolkadotSigner,
  onProgress: (message: string) => void,
): Promise<StoredDataLocation> {
  onProgress("Preparing wallet request...");
  await ensureTransactionSigningPermission();
  const { api } = await getBulletin();

  const contentHash = toHex(parseCid(cid).multihash.digest);
  const tx = api.tx.TransactionStorage.force_renew({
    entry: Enum("ContentHash", contentHash),
  });

  const result = await submitAndWatch(
    tx,
    progressSigner(signer, "Renewal", onProgress),
    {
      waitFor: "finalized",
      timeoutMs: RENEW_TX_TIMEOUT_MS,
      mortalityPeriod: 256,
      onStatus: (status) => onProgress(statusMessage(status)),
    },
  );

  if (!result.ok) throw result.error;
  return {
    blockNumber: result.value.block.number,
    extrinsicIndex: result.value.block.index,
  };
}
