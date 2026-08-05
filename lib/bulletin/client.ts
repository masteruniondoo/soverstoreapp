import {
  createChainClient,
  getClient,
  isConnected,
} from "@parity/product-sdk/chain";
import { devnet_bulletin } from "@parity/product-sdk-descriptors/devnet-bulletin";
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

/** Resolves once the host-routed Bulletin chain answers, returning its name. */
export async function getChainName(): Promise<string> {
  const { client } = await getBulletin();
  const spec = await client.getChainSpecData();
  return spec.name;
}
