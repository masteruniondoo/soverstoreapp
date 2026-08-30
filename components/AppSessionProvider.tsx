"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Allowance } from "@/lib/bulletin/allowance";
import {
  clearBulletinTransportRecovery,
  getBulletinTransportRecovery,
} from "@/lib/bulletin/recovery";
import { useBulletinAllowance } from "@/lib/bulletin/use-allowance";
import {
  connectHostWallet,
  getHostWalletSnapshot,
  selectHostWalletAccount,
  subscribeHostWallet,
  type AppWalletAccount,
  type AppWalletSnapshot,
} from "@/lib/wallet";

type AppSession = {
  accounts: AppWalletAccount[];
  selectedAccount: AppWalletAccount | null;
  selectedAddress: string | null;
  walletStatus: AppWalletSnapshot["status"];
  walletError: string | null;
  connectWallet: () => Promise<AppWalletAccount>;
  selectAccount: (address: string) => void;
  bulletinAllowance: Allowance | null | undefined;
  checkingBulletinAllowance: boolean;
  bulletinAllowanceError: string | null;
  refreshBulletinAllowance: (
    showSpinner?: boolean,
    force?: boolean,
  ) => Promise<Allowance | null>;
  setKnownBulletinAllowance: (
    address: string,
    allowance: Allowance | null,
  ) => void;
};

const AppSessionContext = createContext<AppSession | null>(null);

export function AppSessionProvider({ children }: { children: ReactNode }) {
  const [wallet, setWallet] = useState<AppWalletSnapshot>(() =>
    getHostWalletSnapshot(),
  );
  const {
    allowance: bulletinAllowance,
    checking: checkingBulletinAllowance,
    error: bulletinAllowanceError,
    refresh: refreshBulletinAllowance,
    setKnownAllowance: setKnownBulletinAllowance,
  } = useBulletinAllowance(wallet.selectedAddress);

  useEffect(() => {
    const sync = () => setWallet(getHostWalletSnapshot());
    sync();
    const unsubscribe = subscribeHostWallet(sync);

    // Complete the single automatic recovery requested after a stuck Bulletin
    // ChainHead: reconnect the wallet and restore the same selected address.
    const recovery = getBulletinTransportRecovery();
    if (recovery) {
      void connectHostWallet().then(
        (accounts) => {
          if (accounts.some((account) => account.address === recovery.address)) {
            selectHostWalletAccount(recovery.address);
          }
          sync();
          // Storage, or the verified Drops publisher branch, owns the complete
          // check/authorize flow. Do not start a second read here that could
          // overwrite its fresh liveness result.
        },
        () => {
          clearBulletinTransportRecovery();
          sync();
        },
      );
    }

    return unsubscribe;
  }, []);

  const connectWallet = useCallback(async () => {
    const accounts = await connectHostWallet();
    const snapshot = getHostWalletSnapshot();
    setWallet(snapshot);
    const selected =
      accounts.find((account) => account.address === snapshot.selectedAddress) ??
      accounts[0];
    if (!selected) throw new Error("Host wallet returned no account.");
    return selected;
  }, []);

  const selectAccount = useCallback((address: string) => {
    selectHostWalletAccount(address);
    setWallet(getHostWalletSnapshot());
  }, []);

  const selectedAccount = useMemo(
    () =>
      wallet.accounts.find(
        (account) => account.address === wallet.selectedAddress,
      ) ?? null,
    [wallet.accounts, wallet.selectedAddress],
  );

  const value = useMemo<AppSession>(
    () => ({
      accounts: wallet.accounts,
      selectedAccount,
      selectedAddress: wallet.selectedAddress,
      walletStatus: wallet.status,
      walletError: wallet.error,
      connectWallet,
      selectAccount,
      bulletinAllowance,
      checkingBulletinAllowance,
      bulletinAllowanceError,
      refreshBulletinAllowance,
      setKnownBulletinAllowance,
    }),
    [
      bulletinAllowance,
      bulletinAllowanceError,
      checkingBulletinAllowance,
      connectWallet,
      refreshBulletinAllowance,
      selectAccount,
      selectedAccount,
      setKnownBulletinAllowance,
      wallet.accounts,
      wallet.error,
      wallet.selectedAddress,
      wallet.status,
    ],
  );

  return (
    <AppSessionContext.Provider value={value}>
      {children}
    </AppSessionContext.Provider>
  );
}

export function useAppSession(): AppSession {
  const session = useContext(AppSessionContext);
  if (!session) {
    throw new Error("useAppSession must be used inside AppSessionProvider.");
  }
  return session;
}
