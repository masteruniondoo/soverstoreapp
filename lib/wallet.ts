import type { PolkadotSigner } from "polkadot-api";
import { SignerManager } from "@parity/product-sdk/wallet";

export type AppWalletAccount = {
  address: string;
  name?: string;
  polkadotSigner: PolkadotSigner;
  source: "host";
};

const hostManager = new SignerManager({ dappName: "soverstore.dot" });

export async function connectHostWallet(): Promise<AppWalletAccount[]> {
  const connected = await hostManager.connect();
  if (!connected.ok) {
    throw connected.error;
  }

  const [firstAccount] = connected.value;
  if (!firstAccount) {
    throw new Error("Host wallet returned no accounts.");
  }

  const selected = hostManager.selectAccount(firstAccount.address);
  if (!selected.ok) {
    throw selected.error;
  }

  const selectedSigner = hostManager.getSigner();
  if (!selectedSigner) {
    throw new Error("Host wallet did not provide a signer.");
  }

  return connected.value.map((account) => ({
    address: account.address,
    name: account.name ?? undefined,
    polkadotSigner:
      account.address === firstAccount.address
        ? selectedSigner
        : account.getSigner(),
    source: "host",
  }));
}
