"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { PolkadotSigner } from "polkadot-api";
import {
  listUploadHistory,
  subscribeUploadHistory,
  updateUploadHistoryLocation,
  type UploadHistoryEntry,
} from "./upload-history";
import { fetchCurrentBulletinBlock, fetchRetentionPeriod, renewStoredData } from "./renew";
import { recoverTimedOutBulletinTransport } from "./recovery";

export type FileStatus = "active" | "expiring-soon" | "expired";

export type FileRecord = UploadHistoryEntry & {
  expiresAtBlock: number | null;
  blocksRemaining: number | null;
  /** Share of the retention period still left, 0-100. `null` until chain info loads. */
  percentRemaining: number | null;
  status: FileStatus | null;
};

const EXPIRING_SOON_THRESHOLD_BLOCKS = 1_000;

export function useUploadHistory(account: string | null) {
  const [entries, setEntries] = useState<UploadHistoryEntry[]>([]);
  const [currentBlock, setCurrentBlock] = useState<number | null>(null);
  const [retentionPeriod, setRetentionPeriod] = useState<number | null>(null);
  const [loadingChainInfo, setLoadingChainInfo] = useState(false);
  const [chainInfoError, setChainInfoError] = useState<string | null>(null);

  useEffect(() => {
    if (!account) {
      setEntries([]);
      return;
    }
    setEntries(listUploadHistory(account));
    return subscribeUploadHistory(() => setEntries(listUploadHistory(account)));
  }, [account]);

  const refreshChainInfo = useCallback(async () => {
    setLoadingChainInfo(true);
    setChainInfoError(null);
    try {
      const [block, retention] = await Promise.all([
        fetchCurrentBulletinBlock(),
        fetchRetentionPeriod(),
      ]);
      setCurrentBlock(block);
      setRetentionPeriod(retention);
    } catch (error) {
      if (account && recoverTimedOutBulletinTransport(account, error)) return;
      setChainInfoError(
        error instanceof Error
          ? error.message
          : "Could not read Bulletin chain state.",
      );
    } finally {
      setLoadingChainInfo(false);
    }
  }, [account]);

  useEffect(() => {
    if (!account || entries.length === 0) return;
    void refreshChainInfo();
  }, [account, entries.length, refreshChainInfo]);

  const records = useMemo<FileRecord[]>(
    () =>
      entries.map((entry) => {
        if (currentBlock === null || retentionPeriod === null || retentionPeriod <= 0) {
          return {
            ...entry,
            expiresAtBlock: null,
            blocksRemaining: null,
            percentRemaining: null,
            status: null,
          };
        }
        const expiresAtBlock = entry.blockNumber + retentionPeriod;
        const blocksRemaining = expiresAtBlock - currentBlock;
        const percentRemaining = Math.max(
          0,
          Math.min(100, (blocksRemaining / retentionPeriod) * 100),
        );
        const status: FileStatus =
          blocksRemaining <= 0
            ? "expired"
            : blocksRemaining < EXPIRING_SOON_THRESHOLD_BLOCKS
              ? "expiring-soon"
              : "active";
        return { ...entry, expiresAtBlock, blocksRemaining, percentRemaining, status };
      }),
    [entries, currentBlock, retentionPeriod],
  );

  const renew = useCallback(
    async (
      entry: UploadHistoryEntry,
      signer: PolkadotSigner,
      onProgress: (message: string) => void,
    ) => {
      const location = await renewStoredData(entry.cid, signer, onProgress);
      updateUploadHistoryLocation(entry.cid, entry.account, location);
      await refreshChainInfo();
    },
    [refreshChainInfo],
  );

  return { records, loadingChainInfo, chainInfoError, refreshChainInfo, renew };
}
