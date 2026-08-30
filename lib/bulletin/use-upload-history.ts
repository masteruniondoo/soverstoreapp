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

export type FileStatus = "active" | "expiring-soon" | "expired";

export type FileRecord = UploadHistoryEntry & {
  expiresAtBlock: number | null;
  blocksRemaining: number | null;
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
      setChainInfoError(
        error instanceof Error
          ? error.message
          : "Could not read Bulletin chain state.",
      );
    } finally {
      setLoadingChainInfo(false);
    }
  }, []);

  useEffect(() => {
    if (!account || entries.length === 0) return;
    void refreshChainInfo();
  }, [account, entries.length, refreshChainInfo]);

  const records = useMemo<FileRecord[]>(
    () =>
      entries.map((entry) => {
        if (currentBlock === null || retentionPeriod === null) {
          return {
            ...entry,
            expiresAtBlock: null,
            blocksRemaining: null,
            status: null,
          };
        }
        const expiresAtBlock = entry.blockNumber + retentionPeriod;
        const blocksRemaining = expiresAtBlock - currentBlock;
        const status: FileStatus =
          blocksRemaining <= 0
            ? "expired"
            : blocksRemaining < EXPIRING_SOON_THRESHOLD_BLOCKS
              ? "expiring-soon"
              : "active";
        return { ...entry, expiresAtBlock, blocksRemaining, status };
      }),
    [entries, currentBlock, retentionPeriod],
  );

  const renew = useCallback(
    async (
      entry: UploadHistoryEntry,
      signer: PolkadotSigner,
      onProgress: (message: string) => void,
    ) => {
      const location = await renewStoredData(
        { blockNumber: entry.blockNumber, extrinsicIndex: entry.extrinsicIndex },
        signer,
        onProgress,
      );
      updateUploadHistoryLocation(entry.cid, entry.account, location);
      await refreshChainInfo();
    },
    [refreshChainInfo],
  );

  return { records, loadingChainInfo, chainInfoError, refreshChainInfo, renew };
}
