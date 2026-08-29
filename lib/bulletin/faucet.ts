import {
  AsyncBulletinClient,
  TxStatus,
  type ProgressEvent,
  WaitFor,
} from "@parity/bulletin-sdk";
import { DevProvider } from "@parity/product-sdk/wallet";
import { getBulletin } from "./client";
import type { StoreAuthorization } from "./store";

/** Matches the grant this app requested before the host-managed resource path existed. */
const GRANT_TRANSACTIONS = 100;
const GRANT_BYTES = 10n * 1024n * 1024n;

let eveSignerPromise: ReturnType<typeof resolveEveSigner> | null = null;

async function resolveEveSigner() {
  const connected = await new DevProvider().connect();
  if (!connected.ok) throw connected.error;
  const eve = connected.value.find((account) => account.name === "Eve");
  if (!eve) throw new Error("Devnet faucet account Eve is unavailable.");
  return eve.getSigner();
}

function getEveSigner() {
  if (!eveSignerPromise) {
    eveSignerPromise = resolveEveSigner().catch((error) => {
      eveSignerPromise = null;
      throw error;
    });
  }
  return eveSignerPromise;
}

/**
 * Directly authorizes `address` on Bulletin using the well-known Devnet
 * authorizer account //Eve, the same mechanism this app used before the
 * host-managed resource-allocation path (see git history at 1324fa0). Eve's
 * private key is derived from the public Substrate dev mnemonic, so this is
 * Devnet-only -- it must never run against a production Bulletin chain.
 *
 * Unlike requestResourceAllocation, this has no Desktop/mobile round-trip to
 * get lost: it's a local deterministic signer submitted over the same
 * host-routed chain connection reads already use, and it resolves only once
 * the authorization transaction is finalized.
 */
export async function requestFaucetAllowance(
  address: string,
  onProgress: (message: string) => void,
  minimum?: StoreAuthorization,
): Promise<void> {
  onProgress("Requesting Bulletin storage allowance from the Devnet faucet...");
  const [signer, { api, client }] = await Promise.all([
    getEveSigner(),
    getBulletin(),
  ]);
  const sdk = new AsyncBulletinClient(api, signer, client.submit);

  const transactions = Math.max(
    GRANT_TRANSACTIONS,
    minimum ? Number(minimum.transactions) : 0,
  );
  const bytes = minimum && minimum.bytes > GRANT_BYTES ? minimum.bytes : GRANT_BYTES;

  await sdk
    .authorizeAccount(address, transactions, bytes)
    .withCallback((event: ProgressEvent) => {
      switch (event.type) {
        case TxStatus.Signed:
          onProgress("Faucet authorization signed...");
          break;
        case TxStatus.Broadcasted:
          onProgress("Broadcasting faucet authorization...");
          break;
        case TxStatus.InBlock:
          onProgress(
            `Faucet authorization included in block #${(event as { blockNumber?: number }).blockNumber ?? "..."}...`,
          );
          break;
        case TxStatus.Finalized:
          onProgress("Faucet authorization finalized.");
          break;
      }
    })
    .withWaitFor(WaitFor.Finalized)
    .send();
}
