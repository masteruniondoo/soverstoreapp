import {
  AsyncBulletinClient,
  TxStatus,
  type ProgressEvent,
  WaitFor,
} from "@parity/bulletin-sdk";
import { DevProvider } from "@parity/product-sdk/wallet";
import { BULLETIN_NETWORK_ID } from "@/lib/runtime-config";
import { getBulletin } from "./client";

// Desired grant. //Eve is a shared, community-wide AllowedAuthorizers budget
// (github.com/Polkadot-Community-Foundation/products-devnet-issues#6, #9): it
// only ever shrinks as every builder on the public devnet draws from it, so
// this is a ceiling, not a guarantee -- requestFaucetAllowance caps it to
// whatever remains. Kept small since the grant is soft-priority only: the
// runtime's check_authorization never rejects `store` for insufficient
// allowance, only for a missing/expired authorization record.
const GRANT_TRANSACTIONS = 20;
const GRANT_BYTES = 1024n * 1024n;
const FAUCET_NETWORK_ID = "devnet-bulletin";

let eveAccountPromise: ReturnType<typeof resolveEveAccount> | null = null;

async function resolveEveAccount() {
  const connected = await new DevProvider({ names: ["Eve"] }).connect();
  if (!connected.ok) throw connected.error;
  const eve = connected.value[0];
  if (!eve) throw new Error("Devnet faucet account Eve is unavailable.");
  return { address: eve.address, signer: eve.getSigner() };
}

function getEveAccount() {
  if (!eveAccountPromise) {
    eveAccountPromise = resolveEveAccount().catch((error) => {
      eveAccountPromise = null;
      throw error;
    });
  }
  return eveAccountPromise;
}

type AuthorizerBudget = {
  quota?: { transactions?: string | number | bigint; bytes?: string | number | bigint } | null;
};

/**
 * Reads //Eve's own remaining AllowedAuthorizers quota so a grant request
 * never asks for more than the shared pool has left. `quota: null` means an
 * unlimited authorizer (no cap to apply); a missing entry means //Eve is not
 * (or no longer) a registered authorizer at all.
 */
async function queryEveRemainingBudget(
  eveAddress: string,
): Promise<{ transactions: number; bytes: bigint } | null> {
  const { api } = await getBulletin();
  const budget = (await api.query.TransactionStorage.AllowedAuthorizers.getValue(
    eveAddress,
  )) as AuthorizerBudget | undefined;
  if (!budget) {
    throw new Error(
      "The devnet Bulletin faucet account (//Eve) is not a registered authorizer. See github.com/Polkadot-Community-Foundation/products-devnet-issues.",
    );
  }
  if (!budget.quota) return null;
  return {
    transactions: Number(budget.quota.transactions ?? 0),
    bytes: BigInt(budget.quota.bytes ?? 0),
  };
}

/**
 * Mirrors Bulletin Console's testnet faucet: the public //Eve dev signer
 * grants storage and the call resolves only after `authorize_account` is
 * finalized. The connected user's wallet never signs or approves this
 * authorization transaction.
 *
 * //Eve's AllowedAuthorizers quota is a budget shared by every builder on the
 * public devnet. Requesting more than what remains does not get rejected
 * before inclusion -- `authorize_account`'s origin check fails inside the
 * dispatchable itself, so the extrinsic still lands in a finalized block with
 * no authorization written (surfacing later as a confusing "finalized but not
 * visible on-chain" result). Reading the remaining quota first and capping
 * the request to it avoids sending a doomed transaction.
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
  const [{ address: eveAddress, signer }, { api, client }] = await Promise.all([
    getEveAccount(),
    getBulletin(),
  ]);

  const remainingBudget = await queryEveRemainingBudget(eveAddress);
  const transactions =
    remainingBudget === null
      ? GRANT_TRANSACTIONS
      : Math.min(GRANT_TRANSACTIONS, remainingBudget.transactions);
  const bytes =
    remainingBudget === null
      ? GRANT_BYTES
      : remainingBudget.bytes < GRANT_BYTES
        ? remainingBudget.bytes
        : GRANT_BYTES;
  if (transactions <= 0 || bytes <= 0n) {
    throw new Error(
      "The shared devnet Bulletin faucet account (//Eve) has no remaining authorizer budget right now. This is a community-wide resource; see github.com/Polkadot-Community-Foundation/products-devnet-issues for a top-up.",
    );
  }

  const sdk = new AsyncBulletinClient(api, signer, client.submit);

  await sdk
    .authorizeAccount(address, transactions, bytes)
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
