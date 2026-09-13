import {
  createChainClient,
  getClient,
  isConnected,
} from "@parity/product-sdk/chain";
import { devnet_bulletin } from "@parity/product-sdk-descriptors/devnet-bulletin";
import { paseo_bulletin } from "@parity/product-sdk-descriptors/paseo-bulletin";
import type { PolkadotClient } from "polkadot-api";

type Bulletin = {
  client: PolkadotClient;
  /**
   * The generated Devnet Bulletin API. Kept structurally loose because the
   * Bulletin SDK supports more than one runtime naming convention.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api: any;
  destroy: () => void;
};

let bulletinPromise: Promise<Bulletin> | null = null;

function connectedBulletin(): Bulletin | null {
  if (!isConnected(devnet_bulletin)) return null;

  // Drops checks the contract owner through getChainAPI("devnet"). That SDK
  // preset already opens Asset Hub, Bulletin and Individuality together. Reuse
  // its Bulletin client instead of opening a second host subscription for the
  // same genesis hash under a different SDK cache fingerprint. The duplicate
  // subscription is what left the Drops lookup pending even though the exact
  // same account query worked when Storage was opened first.
  const client = getClient(devnet_bulletin);
  return {
    client,
    api: client.getTypedApi(devnet_bulletin),
    // This module does not own a client borrowed from the Devnet preset.
    destroy: () => undefined,
  };
}

/**
 * Lazily creates a host-routed client for the Products Devnet Bulletin.
 * No Product Remote permission is needed: Desktop owns the chain connection,
 * while SoverStore receives only the typed host provider.
 */
export function getBulletin(): Promise<Bulletin> {
  if (!bulletinPromise) {
    const connected = connectedBulletin();
    const pending = connected
      ? Promise.resolve(connected)
      : createChainClient({
          chains: { bulletin: devnet_bulletin },
        }).then((chain) => ({
          client: chain.raw.bulletin,
          api: chain.bulletin,
          destroy: chain.destroy,
        }));
    bulletinPromise = pending;
    void pending.catch(() => {
      if (bulletinPromise === pending) {
        // Do not cache a transient host-provider failure for the page lifetime.
        bulletinPromise = null;
      }
    });
  }
  return bulletinPromise;
}

/**
 * Drops a completed but unusable Bulletin connection before a real retry.
 * Never call this while a PAPI storage operation is still pending: destroying
 * that operation would send the stop-operation frame unsupported by older
 * Polkadot Desktop builds.
 */
export async function resetBulletin(): Promise<void> {
  const pending = bulletinPromise;
  if (!pending) return;
  if (bulletinPromise === pending) bulletinPromise = null;
  try {
    const bulletin = await pending;
    bulletin.destroy();
  } catch {
    // Creation failures already clear their own cache entry.
  }
}

/**
 * A second typed view of the same Bulletin connection, for the one storage
 * entry whose `devnet_bulletin` descriptor no longer matches the chain.
 *
 * Devnet Bulletin (genesis 0xe101f0fa…) was upgraded past the runtime the
 * published descriptors were generated from, so
 * `TransactionStorage.Authorizations` decodes to a different shape than
 * `devnet_bulletin` declares - PAPI rejects the read with "Incompatible runtime
 * entry Storage(TransactionStorage.Authorizations)". Verified against the live
 * chain: both descriptors 0.8.0 and 0.11.0 fail, so this is the chain moving
 * on rather than anything this app changed. Every other entry SoverStore uses
 * (AllowedAuthorizers, RetentionPeriod, System.Number, store,
 * store_with_cid_config) still matches and keeps using `devnet_bulletin`.
 *
 * `paseo_bulletin` is a different chain, but its metadata carries the newer
 * Authorizations type that this chain now runs, and it decodes the live value
 * correctly. Only the metadata is borrowed: the connection, and therefore the
 * chain actually read, stays the Devnet one.
 *
 * Revisit when @parity/product-sdk-descriptors ships a devnet_bulletin
 * regenerated against the current runtime; this indirection can then go.
 */
export async function getAuthorizationsApi(): Promise<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any
> {
  const { client } = await getBulletin();
  return client.getTypedApi(paseo_bulletin);
}

/** Resolves once the host-routed Bulletin chain answers, returning its name. */
export async function getChainName(): Promise<string> {
  const { client } = await getBulletin();
  const spec = await client.getChainSpecData();
  return spec.name;
}
