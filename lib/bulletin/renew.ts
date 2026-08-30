import { Enum, type PolkadotSigner } from "polkadot-api";
import { submitAndWatch, type TxStatus } from "@parity/product-sdk-tx";
import { ensureTransactionSigningPermission } from "@/lib/wallet";
import { getBulletin } from "./client";
import { progressSigner } from "./store";

const RENEW_TX_TIMEOUT_MS = 180_000;

export type StoredDataLocation = {
  blockNumber: number;
  extrinsicIndex: number;
};

/** Blocks a stored (ephemeral) transaction survives before it is dropped unless renewed. */
export async function fetchRetentionPeriod(): Promise<number> {
  const { api } = await getBulletin();
  const period = await api.query.TransactionStorage.RetentionPeriod.getValue();
  return Number(period);
}

export async function fetchCurrentBulletinBlock(): Promise<number> {
  const { api } = await getBulletin();
  return Number(await api.query.System.Number.getValue());
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
 * The renewed data moves to a new (block, index) location, which the caller
 * must persist for any future renewal of the same file.
 */
export async function renewStoredData(
  location: StoredDataLocation,
  signer: PolkadotSigner,
  onProgress: (message: string) => void,
): Promise<StoredDataLocation> {
  onProgress("Preparing wallet request...");
  await ensureTransactionSigningPermission();
  const { api } = await getBulletin();

  const tx = api.tx.TransactionStorage.force_renew({
    entry: Enum("Position", {
      block: location.blockNumber,
      index: location.extrinsicIndex,
    }),
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
