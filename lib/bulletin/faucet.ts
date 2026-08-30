import {
  AsyncBulletinClient,
  TxStatus,
  type ProgressEvent,
  WaitFor,
} from "@parity/bulletin-sdk";
import { DevProvider } from "@parity/product-sdk/wallet";
import { BULLETIN_NETWORK_ID } from "@/lib/runtime-config";
import { getBulletin } from "./client";

const GRANT_TRANSACTIONS = 100;
const GRANT_BYTES = 10n * 1024n * 1024n;
const FAUCET_NETWORK_ID = "devnet-bulletin";

let eveSignerPromise: ReturnType<typeof resolveEveSigner> | null = null;

async function resolveEveSigner() {
  const connected = await new DevProvider({ names: ["Eve"] }).connect();
  if (!connected.ok) throw connected.error;
  const eve = connected.value[0];
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
 * Mirrors Bulletin Console's testnet faucet exactly: the public //Eve dev
 * signer grants 100 transactions / 10 MiB and the call resolves only after
 * `authorize_account` is finalized. The connected user's wallet never signs
 * or approves this authorization transaction.
 */
export async function requestFaucetAllowance(
  address: string,
  onProgress: (message: string) => void,
): Promise<void> {
  if (BULLETIN_NETWORK_ID !== FAUCET_NETWORK_ID) {
    throw new Error(
      `The public Bulletin faucet is restricted to ${FAUCET_NETWORK_ID}; refusing to use //Eve on ${BULLETIN_NETWORK_ID}.`,
    );
  }

  onProgress("Preparing automatic Bulletin authorization...");
  const [signer, { api, client }] = await Promise.all([
    getEveSigner(),
    getBulletin(),
  ]);
  const sdk = new AsyncBulletinClient(api, signer, client.submit);

  await sdk
    .authorizeAccount(address, GRANT_TRANSACTIONS, GRANT_BYTES)
    .withCallback((event: ProgressEvent) => {
      switch (event.type) {
        case TxStatus.Signed:
          onProgress("Authorization transaction signed...");
          break;
        case TxStatus.Broadcasted:
          onProgress("Broadcasting authorization to Bulletin...");
          break;
        case TxStatus.InBlock:
          onProgress(
            `Authorization included in block #${(event as { blockNumber?: number }).blockNumber ?? "..."}; waiting for finalization...`,
          );
          break;
        case TxStatus.Finalized:
          onProgress("Authorization finalized on Bulletin.");
          break;
      }
    })
    .withWaitFor(WaitFor.Finalized)
    .send();
}
