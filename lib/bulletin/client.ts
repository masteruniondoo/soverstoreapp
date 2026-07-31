import { createChainClient } from "@parity/product-sdk/chain";
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
};

let bulletinPromise: Promise<Bulletin> | null = null;

/** Lazily creates a host-routed client for the Products Devnet Bulletin. */
export function getBulletin(): Promise<Bulletin> {
  if (!bulletinPromise) {
    bulletinPromise = createChainClient({
      chains: { bulletin: devnet_bulletin },
    }).then((chain) => ({
      client: chain.raw.bulletin,
      api: chain.bulletin,
    }));
  }
  return bulletinPromise;
}

/** Resolves once the host-routed chain answers, returning its name. */
export async function getChainName(): Promise<string> {
  const { client } = await getBulletin();
  const spec = await client.getChainSpecData();
  return spec.name;
}
