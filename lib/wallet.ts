import type { PolkadotSigner } from "polkadot-api";
import { createLazySigner } from "@parity/product-sdk/cloud-storage";
import {
  requestPermission,
  requestResourceAllocation,
} from "@parity/product-sdk/host";
import {
  DevProvider,
  HostProvider,
  SignerManager,
  type SignerAccount,
  type SignerState,
} from "@parity/product-sdk/wallet";
import { SmartContractAllocationCoordinator } from "@/lib/wallet/smart-contract-allocation";

export type AppWalletAccount = {
  address: string;
  name?: string;
  polkadotSigner: PolkadotSigner;
  source: "host";
};

const DAPP_NAME = "soverstore.dot";
const hostManager = new SignerManager({
  dappName: DAPP_NAME,
  // SignerManager does not forward HostProvider's defer-permission option, so
  // inject the otherwise identical provider explicitly. Connecting is an
  // identity/read-only operation and must expose only the selected address.
  createProvider: (type) =>
    type === "host"
      ? new HostProvider({
          dappName: DAPP_NAME,
          requestChainSubmitPermission: false,
        })
      : new DevProvider(),
});
const HOST_PERMISSION_TIMEOUT_MS = 15_000;
// The host can keep a first-time mobile allocation prompt open for 60 seconds.
// Leave enough time for the decision to travel back over the Desktop bridge;
// a 30-second deadline could reject an approval that was still being handled.
const HOST_RESOURCE_TIMEOUT_MS = 90_000;
const HOST_POST_CONNECT_SETTLE_MS = 2_500;
const HOST_RELOAD_DELAY_MS = 2_500;
let connectPromise: Promise<AppWalletAccount[]> | null = null;
let chainSubmitPermissionVerified = false;
const smartContractAllocation = new SmartContractAllocationCoordinator(
  () => typeof window === "undefined" ? null : window.sessionStorage,
  undefined,
  () => console.warn(
    "[soverstore] Smart-contract allocation response timed out; continuing with host-side implicit allocation.",
  ),
);
let hostWasConnected = hostManager.getState().status === "connected";
let hostReloadTimer: ReturnType<typeof setTimeout> | null = null;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms.`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function forgetSmartContractAllowance(address: string): void {
  smartContractAllocation.forget(address);
}

function currentSigner(address: string): PolkadotSigner | null {
  const state = hostManager.getState();
  if (state.status !== "connected") return null;
  return state.accounts.find((account) => account.address === address)?.getSigner() ?? null;
}

function toAppAccount(account: SignerAccount): AppWalletAccount {
  return {
    address: account.address,
    name: account.name ?? undefined,
    // A SignerAccount belongs to one concrete HostProvider instance. The host
    // may replace that provider while the app stays mounted (Desktop renderer
    // restart, mobile re-pair, SSO refresh), so retaining account.getSigner()
    // here leaves every later transaction attached to a dead MessagePort.
    // Resolve the account and signer again at the exact time of every signature.
    polkadotSigner: createLazySigner(
      () => currentSigner(account.address),
      "The Polkadot Desktop connection was interrupted. SoverStore is restoring it; retry after the app reloads.",
    ),
    source: "host",
  };
}

function orderedAccounts(state: SignerState): AppWalletAccount[] {
  const accounts = state.accounts.map(toAppAccount);
  const selected = state.selectedAccount?.address;
  if (!selected) return accounts;
  return accounts.sort((left, right) =>
    left.address === selected ? -1 : right.address === selected ? 1 : 0,
  );
}

async function verifyChainSubmitPermission(): Promise<void> {
  if (hostManager.getState().status !== "connected") {
    throw new Error(
      "The Polkadot Desktop connection is not ready. Wait for SoverStore to reload, then retry.",
    );
  }
  if (chainSubmitPermissionVerified) return;
  const permission = await withTimeout(
    requestPermission({ tag: "ChainSubmit", value: undefined }),
    HOST_PERMISSION_TIMEOUT_MS,
    "Wallet signing permission",
  );
  if (!permission.ok) throw permission.error;
  if (!permission.value) {
    throw new Error("Wallet connection was approved, but transaction signing permission was denied.");
  }
  chainSubmitPermissionVerified = true;
}

export type AppWalletSnapshot = {
  status: SignerState["status"];
  accounts: AppWalletAccount[];
  selectedAddress: string | null;
  error: string | null;
};

export function getHostWalletSnapshot(): AppWalletSnapshot {
  const state = hostManager.getState();
  const connected = state.status === "connected";
  return {
    status: state.status,
    accounts: connected ? orderedAccounts(state) : [],
    // Never expose a selected address while its HostProvider is reconnecting.
    // That prevents upload buttons from using a signer that only looks live.
    selectedAddress: connected ? state.selectedAccount?.address ?? null : null,
    error: state.error?.message ?? null,
  };
}

export function subscribeHostWallet(listener: () => void): () => void {
  return hostManager.subscribe((state) => {
    if (state.status === "connected") {
      hostWasConnected = true;
    } else {
      chainSubmitPermissionVerified = false;

      // TruAPI 0.6 keeps the first injected MessagePort in a module-level
      // client cache even after that port closes. SignerManager therefore logs
      // "attempting reconnect" but the replacement HostProvider receives the
      // same closed transport. A document reload is the supported way to ask
      // Desktop for a fresh port. Do it automatically so the user never has to
      // discover that a manual refresh fixes wallet and chain reads.
      if (
        hostWasConnected &&
        hostReloadTimer === null &&
        typeof window !== "undefined"
      ) {
        console.warn(
          "[soverstore] Host connection closed; reloading to obtain a fresh Desktop transport.",
        );
        hostReloadTimer = setTimeout(() => {
          window.location.reload();
        }, HOST_RELOAD_DELAY_MS);
      }
    }
    listener();
  });
}

export function selectHostWalletAccount(address: string): AppWalletAccount {
  const selected = hostManager.selectAccount(address);
  if (!selected.ok) throw selected.error;
  return toAppAccount(selected.value);
}

/** Re-validates the host permission that gates every mobile signing request. */
export function ensureTransactionSigningPermission(): Promise<void> {
  return verifyChainSubmitPermission();
}

async function ensureResourceAllowance(
  resource:
    | { tag: "BulletinAllowance"; value: undefined }
    | {
        tag: "SmartContractAllowance";
        value: number;
      },
  label: string,
): Promise<void> {
  const allocation = await withTimeout(
    requestResourceAllocation([resource]),
    HOST_RESOURCE_TIMEOUT_MS,
    `${label} allocation`,
  );
  if (!allocation.ok) throw allocation.error;

  const [outcome] = allocation.value;
  if (outcome === "Rejected") {
    throw new Error(`${label} allowance was rejected.`);
  }
  if (outcome !== "Allocated") {
    throw new Error(`${label} allowance is not available in this host.`);
  }
}

export function ensureSmartContractAllowance(address: string): Promise<void> {
  return smartContractAllocation.ensure(address, () =>
    ensureResourceAllowance(
      {
        tag: "SmartContractAllowance",
        value: 0,
      },
      "Smart-contract transaction",
    ));
}

export function ensureBulletinAllowance(): Promise<void> {
  return ensureResourceAllowance(
    { tag: "BulletinAllowance", value: undefined },
    "Bulletin storage",
  );
}

export async function connectHostWallet(): Promise<AppWalletAccount[]> {
  const current = hostManager.getState();
  if (current.status === "connected" && current.selectedAccount) {
    return orderedAccounts(current);
  }

  if (!connectPromise) {
    connectPromise = (async () => {
      const connected = await hostManager.connect();
      if (!connected.ok) throw connected.error;

      const state = hostManager.getState();
      if (!state.selectedAccount) {
        throw new Error("Host wallet returned no accounts.");
      }

      // A newly paired phone can still be dismissing its non-cancellable
      // "Connecting device" modal when SignerManager reports connected. If a
      // resource prompt is sent in that window, the phone may show/accept it
      // while Desktop never receives the outcome. Existing sessions bypass
      // this path, so only a fresh connection pays this short grace period.
      await delay(HOST_POST_CONNECT_SETTLE_MS);
      return orderedAccounts(hostManager.getState());
    })().finally(() => {
      connectPromise = null;
    });
  }
  return connectPromise;
}
