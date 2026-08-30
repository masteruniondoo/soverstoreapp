import { BULLETIN_NETWORK_ID } from "@/lib/runtime-config";

export type UploadHistoryEntry = {
  cid: string;
  fileName: string;
  size: number;
  blockNumber: number;
  extrinsicIndex: number;
  timestamp: number;
  account: string;
  networkId: string;
};

const STORAGE_KEY = "soverstore:upload-history";

type Listener = () => void;
const listeners = new Set<Listener>();

function readAll(): UploadHistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as UploadHistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function writeAll(entries: UploadHistoryEntry[]): void {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {
      // Storage full or unavailable; listeners still see the update below.
    }
  }
  for (const listener of listeners) listener();
}

export function subscribeUploadHistory(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Records one successful upload from this browser, scoped to the connected
 * account and Bulletin network. This is client-only bookkeeping so "My
 * Files" can show a name and a renew button next to each CID -- the chain
 * itself has no concept of a file name.
 */
export function addUploadHistoryEntry(
  entry: Omit<UploadHistoryEntry, "timestamp" | "networkId">,
): void {
  writeAll([
    { ...entry, networkId: BULLETIN_NETWORK_ID, timestamp: Date.now() },
    ...readAll(),
  ]);
}

export function listUploadHistory(account: string): UploadHistoryEntry[] {
  return readAll().filter(
    (entry) => entry.account === account && entry.networkId === BULLETIN_NETWORK_ID,
  );
}

/**
 * `force_renew` moves the renewed data to a new (block, index) location;
 * any later renewal of the same file must reference that new location.
 */
export function updateUploadHistoryLocation(
  cid: string,
  account: string,
  location: { blockNumber: number; extrinsicIndex: number },
): void {
  writeAll(
    readAll().map((entry) =>
      entry.cid === cid &&
      entry.account === account &&
      entry.networkId === BULLETIN_NETWORK_ID
        ? { ...entry, ...location }
        : entry,
    ),
  );
}

export function removeUploadHistoryEntry(cid: string, account: string): void {
  writeAll(
    readAll().filter(
      (entry) =>
        !(
          entry.cid === cid &&
          entry.account === account &&
          entry.networkId === BULLETIN_NETWORK_ID
        ),
    ),
  );
}
