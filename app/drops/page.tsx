"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ss58ToH160 } from "@parity/product-sdk/address";
import { AddressRow } from "@/components/AddressRow";
import { useAppSession } from "@/components/AppSessionProvider";
import { BulletinBalanceNotice } from "@/components/BulletinBalanceNotice";
import { OpenDropLinkForm } from "@/components/drops/OpenDropLinkForm";
import { DropShareActions } from "@/components/drops/DropShareActions";
import { useFocusedDropId } from "@/components/drops/DropRouteContext";
import { recoverTimedOutBulletinTransport } from "@/lib/bulletin/recovery";
import { Nav } from "@/components/Nav";
import { useAndroidFileNotice } from "@/components/useAndroidFileNotice";
import {
  buildHeader,
  decodeBlob,
  decodeInner,
  encodeBlob,
  encodeInner,
  estimateBlobSize,
  MAX_UPLOAD_SIZE,
  type ProofyInnerMeta,
} from "@/lib/blob/format";
import {
  ensureAccountBulletinReady,
  storeBlob,
} from "@/lib/bulletin";
import { fetchBlobByCid } from "@/lib/bulletin/retrieve";
import { aesGcmDecrypt, aesGcmEncrypt } from "@/lib/crypto/aes";
import { base64ToBytes } from "@/lib/crypto/hash";
import { randomBytes } from "@/lib/crypto/random";
import {
  generateContentKey,
  unwrapContentKey,
  wrapContentKey,
} from "@/lib/crypto/wrap";
import {
  BUY_GAS_RESERVE_SDK,
  contractPriceToSdkValue,
  createDropsContractClient,
  getAssetHubBalance,
  PAS_CONTRACT_UNIT,
  PAS_SDK_UNIT,
  type DropInfo,
  type DropsContractClient,
} from "@/lib/drops/contract";
import {
  loadDropsEncryptionKeyForPublicKey,
  loadOrCreateDropsEncryptionKey,
} from "@/lib/drops/keys";
import {
  copyDocument,
  createDocumentUrl,
  documentPreviewKind,
  downloadDocument,
  type RecoveredDocument,
} from "@/lib/recovered-document";
import { formatBytes, formatNumber } from "@/lib/format";

type OpenState =
  | { status: "idle" }
  | { status: "loading"; message: string }
  | { status: "lost-key"; message: string }
  | { status: "unreadable"; message: string }
  | { status: "ready"; document: RecoveredDocument; downloadError?: string };

type BuyState =
  | { status: "idle" }
  | { status: "working"; message: string }
  | { status: "error"; message: string; insufficientFunds?: boolean }
  | { status: "done"; txHash: string };

type OwnerActionState =
  | { status: "idle" }
  | { status: "working"; message: string }
  | { status: "error"; message: string }
  | { status: "done"; message: string };

type AccountRoleState =
  | { status: "idle" }
  | { status: "checking"; address: string }
  | { status: "buyer"; address: string }
  | { status: "owner"; address: string }
  | { status: "error"; address: string; message: string };

type PublishRetry = {
  cid: string;
  contentKey: Uint8Array;
  buyers: string[];
  publicKeys: Uint8Array[];
  blobSize: number;
};

const ENVELOPE_BATCH_SIZE = 20;
const READ_QUERY_CONCURRENCY = 3;

async function mapWithConcurrency<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(limit, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(values[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function publicKeyLabel(key: Uint8Array): string {
  return Array.from(key.slice(0, 8), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function messageOf(error: unknown): string {
  if (error && typeof error === "object") {
    const payload = (error as { payload?: unknown }).payload;
    if (payload && typeof payload === "object") {
      const reason = (payload as { reason?: unknown }).reason;
      if (typeof reason === "string" && reason.trim()) return reason;
    }
    if (error instanceof Error) return error.message;
  }
  return String(error);
}

function formatPas(value: bigint): string {
  const whole = value / PAS_CONTRACT_UNIT;
  const remainder = value % PAS_CONTRACT_UNIT;
  if (remainder === 0n) return `${whole} PAS`;
  const fraction = remainder.toString().padStart(18, "0").replace(/0+$/, "");
  return `${whole}.${fraction} PAS`;
}

function formatDeadline(timestamp: bigint): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(Number(timestamp) * 1000));
}

function countdown(deadline: bigint, now: number): string {
  const remaining = Number(deadline) - now;
  if (remaining <= 0) return "Sale closed";
  const days = Math.floor(remaining / 86_400);
  const hours = Math.floor((remaining % 86_400) / 3_600);
  const minutes = Math.floor((remaining % 3_600) / 60);
  const seconds = remaining % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function formatSdkPas(value: bigint): string {
  const whole = value / PAS_SDK_UNIT;
  const remainder = value % PAS_SDK_UNIT;
  if (remainder === 0n) return `${whole} PAS`;
  return `${whole}.${remainder.toString().padStart(10, "0").replace(/0+$/, "")} PAS`;
}

function friendlyBuyError(error: unknown): string {
  const message = messageOf(error);
  const normalized = message.toLowerCase();
  if (normalized.includes("sale closed")) return "Deadline passed.";
  if (normalized.includes("underpaid")) return "The on-chain price changed. Refresh the drop and retry.";
  if (normalized.includes("already bought")) return "Access is already held for this drop.";
  if (normalized.includes("signing was rejected") || normalized.includes("user rejected")) {
    return "Transaction signing was rejected.";
  }
  return message;
}

function friendlyOwnerError(error: unknown): string {
  const message = messageOf(error);
  const normalized = message.toLowerCase();
  if (normalized.includes("no allowance set for account")) {
    return "The Product account has no smart-contract transaction allowance. Approve the allowance request and retry.";
  }
  if (normalized.includes("not owner")) return "Owner action from a non-owner account.";
  if (normalized.includes("sale still open")) return "Deadline has not passed.";
  if (normalized.includes("already published")) return "Drop is already published.";
  if (normalized.includes("not a buyer")) return "Envelope batch contains an unregistered address — this is a bug.";
  if (normalized.includes("signing was rejected") || normalized.includes("user rejected")) return "Transaction signing was rejected.";
  return message;
}

function parsePasPrice(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,10}))?$/.exec(value.trim());
  if (!match) throw new Error("Price must be a positive PAS amount with at most 10 decimal places.");
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? "").padEnd(10, "0") || "0");
  const price = whole * PAS_CONTRACT_UNIT + fraction * 10n ** 8n;
  if (price <= 0n) throw new Error("Price must be greater than zero.");
  return price;
}

export default function DropsPage() {
  const focusedDropId = useFocusedDropId();
  const [drops, setDrops] = useState<DropInfo[]>([]);
  const [accountRole, setAccountRole] = useState<AccountRoleState>({
    status: "idle",
  });
  const [buyerByDrop, setBuyerByDrop] = useState<Record<string, boolean>>({});
  const [buyerResultEvm, setBuyerResultEvm] = useState<string | null>(null);
  const [localKeyByDrop, setLocalKeyByDrop] = useState<
    Record<string, "unknown" | "available" | "missing">
  >({});
  const [buyByDrop, setBuyByDrop] = useState<Record<string, BuyState>>({});
  const [createName, setCreateName] = useState("");
  const [createPrice, setCreatePrice] = useState("1");
  const [createDeadline, setCreateDeadline] = useState("");
  const [createState, setCreateState] = useState<OwnerActionState>({ status: "idle" });
  const [createdDrop, setCreatedDrop] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [bulletinState, setBulletinState] = useState<OwnerActionState>({ status: "idle" });
  const [bulletinResultAddress, setBulletinResultAddress] = useState<string | null>(null);
  const { showAndroidNotice, notifyFilePickerAttempt } = useAndroidFileNotice();
  const [fileByDrop, setFileByDrop] = useState<Record<string, File | undefined>>({});
  const [publishByDrop, setPublishByDrop] = useState<Record<string, OwnerActionState>>({});
  const [retryByDrop, setRetryByDrop] = useState<Record<string, PublishRetry | undefined>>({});
  const [openByDrop, setOpenByDrop] = useState<Record<string, OpenState>>({});
  const [loading, setLoading] = useState(true);
  const [focusedDropMissing, setFocusedDropMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const clientRef = useRef<DropsContractClient | null>(null);
  const clientPromiseRef = useRef<Promise<DropsContractClient> | null>(null);
  const objectUrlsRef = useRef(new Set<string>());
  const publisherFlowRef = useRef<{ address: string; runId: number } | null>(null);
  const walletConnectInProgressRef = useRef(false);

  const {
    selectedAccount: account,
    selectedAddress,
    walletStatus,
    connectWallet: connectSessionWallet,
    bulletinAllowance,
    checkingBulletinAllowance,
    bulletinAllowanceError,
    refreshBulletinAllowance,
    setKnownBulletinAllowance,
  } = useAppSession();
  const connectedSs58 = selectedAddress ?? "";
  const connectedEvm = useMemo(
    () => (selectedAddress ? ss58ToH160(selectedAddress) : ""),
    [selectedAddress],
  );

  const currentAccountRole =
    accountRole.status !== "idle" && accountRole.address === selectedAddress
      ? accountRole
      : ({ status: "idle" } as const);
  const isOwner = currentAccountRole.status === "owner";
  const bulletinUsable =
    bulletinResultAddress === selectedAddress &&
    bulletinAllowance?.usable === true;
  const publisherReady =
    isOwner &&
    bulletinUsable &&
    !checkingBulletinAllowance;

  const getReadClient = useCallback(async () => {
    if (clientRef.current) return clientRef.current;
    if (!clientPromiseRef.current) {
      clientPromiseRef.current = createDropsContractClient();
    }
    const pending = clientPromiseRef.current;
    try {
      const client = await pending;
      clientRef.current = client;
      return client;
    } finally {
      if (clientPromiseRef.current === pending) clientPromiseRef.current = null;
    }
  }, []);

  const readBuyerStatus = useCallback(
    async (client: DropsContractClient, evm: string, currentDrops: DropInfo[]) => {
      const entries = await mapWithConcurrency(
        currentDrops,
        READ_QUERY_CONCURRENCY,
        async (drop) => [
          drop.id.toString(),
          await client.isBuyer(drop.id, evm),
        ] as const,
      );
      const statuses = Object.fromEntries(entries);
      const keyStatuses: Record<string, "unknown" | "available" | "missing"> = {};
      for (const drop of currentDrops) {
        const key = drop.id.toString();
        if (!statuses[key]) continue;
        try {
          const registered = await client.encKeyOf(drop.id, evm);
          keyStatuses[key] = await loadDropsEncryptionKeyForPublicKey(
            evm,
            registered,
          ) ? "available" : "missing";
        } catch {
          keyStatuses[key] = "unknown";
        }
      }
      return { statuses, keyStatuses };
    },
    [],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const client = await getReadClient();
      if (focusedDropId) {
        const drop = await client.dropInfo(BigInt(focusedDropId));
        if (drop.payDeadline === 0n) {
          setDrops([]);
          setFocusedDropMissing(true);
        } else {
          setDrops([drop]);
          setFocusedDropMissing(false);
        }
        return;
      }
      const count = await client.dropCount();
      const ids = Array.from(
        { length: Number(count) },
        (_, index) => count - BigInt(index),
      );
      const nextDrops = await mapWithConcurrency(
        ids,
        READ_QUERY_CONCURRENCY,
        (id) => client.dropInfo(id),
      );
      setDrops(nextDrops);
    } catch (nextError) {
      setError(messageOf(nextError));
    } finally {
      setLoading(false);
    }
  }, [focusedDropId, getReadClient]);

  useEffect(() => {
    if (!selectedAddress && !focusedDropId) {
      setLoading(false);
      return;
    }
    void refresh();
  }, [focusedDropId, refresh, selectedAddress]);

  // A connected wallet is immediately sufficient for buyer actions. Buyer
  // bookkeeping is read independently and never blocks the Buy button.
  useEffect(() => {
    let active = true;
    if (!connectedEvm) {
      setBuyerByDrop({});
      setLocalKeyByDrop({});
      setBuyerResultEvm(null);
      return;
    }
    setBuyerResultEvm(null);
    void (async () => {
      const client = await getReadClient();
      const next = await readBuyerStatus(client, connectedEvm, drops);
      if (!active) return;
      setBuyerByDrop(next.statuses);
      setLocalKeyByDrop(next.keyStatuses);
      setBuyerResultEvm(connectedEvm);
    })().catch((nextError) => {
      if (active) setError(messageOf(nextError));
    });
    return () => {
      active = false;
    };
  }, [connectedEvm, drops, getReadClient, readBuyerStatus]);

  useEffect(() => {
    const timer = window.setInterval(
      () => setNow(Math.floor(Date.now() / 1000)),
      1_000,
    );
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const urls = objectUrlsRef.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  const startPublisherDiscovery = useCallback((address: string, force = false) => {
    if (!force && publisherFlowRef.current?.address === address) return;
    const runId = (publisherFlowRef.current?.runId ?? 0) + 1;
    publisherFlowRef.current = { address, runId };
    const evm = ss58ToH160(address);
    const isCurrent = () =>
      publisherFlowRef.current?.address === address &&
      publisherFlowRef.current.runId === runId;

    setAccountRole({ status: "checking", address });
    setBulletinResultAddress(null);
    setBulletinState({ status: "idle" });

    void (async () => {
      const client = await getReadClient();
      const contractOwner = await client.owner();
      if (!isCurrent()) return;

      if (contractOwner.toLowerCase() !== evm.toLowerCase()) {
        setAccountRole({ status: "buyer", address });
        return;
      }

      // The address is now positively verified as the publisher. Only this
      // branch may touch Bulletin; buyers are already free to purchase drops.
      setAccountRole({ status: "owner", address });
      setBulletinState({
        status: "working",
        message: "Preparing publisher Bulletin authorization...",
      });
      try {
        // The publisher uses the same complete automatic procedure as Storage:
        // lookup first, then the direct Devnet faucet only when missing/expired.
        const next = await ensureAccountBulletinReady(
          address,
          (message) => {
            if (isCurrent()) {
              setBulletinState({ status: "working", message });
            }
          },
        );
        if (!isCurrent()) return;
        setKnownBulletinAllowance(address, next);
        setBulletinResultAddress(address);
        setBulletinState({
          status: "done",
          message:
            next.expiresAtBlock === undefined
              ? "Bulletin authorization is active."
              : `Bulletin authorization is active until block #${formatNumber(next.expiresAtBlock)}.`,
        });
      } catch (authorizationError) {
        if (!isCurrent()) return;
        if (recoverTimedOutBulletinTransport(address, authorizationError)) return;
        setBulletinState({
          status: "error",
          message: messageOf(authorizationError),
        });
      }
    })().catch((nextError) => {
      if (!isCurrent()) return;
      setAccountRole({
        status: "error",
        address,
        message: messageOf(nextError),
      });
    });
  }, [getReadClient, setKnownBulletinAllowance]);

  // Also covers a wallet connected on Storage before navigating here and the
  // address restored after a transport-recovery reload.
  useEffect(() => {
    if (focusedDropId) {
      publisherFlowRef.current = null;
      setAccountRole({ status: "idle" });
      setBulletinResultAddress(null);
      setBulletinState({ status: "idle" });
      return;
    }
    if (!selectedAddress) {
      publisherFlowRef.current = null;
      setAccountRole({ status: "idle" });
      setBulletinResultAddress(null);
      setBulletinState({ status: "idle" });
      return;
    }
    if (!walletConnectInProgressRef.current) {
      startPublisherDiscovery(selectedAddress);
    }
  }, [focusedDropId, selectedAddress, startPublisherDiscovery]);

  const connect = useCallback(async () => {
    walletConnectInProgressRef.current = true;
    setError(null);
    try {
      const connected = await connectSessionWallet();
      // This starts only after connectSessionWallet's post-connect settle has
      // completed; the selectedAddress effect is suppressed during that wait.
      if (!focusedDropId) startPublisherDiscovery(connected.address);
    } catch (nextError) {
      setError(messageOf(nextError));
    } finally {
      walletConnectInProgressRef.current = false;
    }
  }, [connectSessionWallet, focusedDropId, startPublisherDiscovery]);

  const buyDrop = useCallback(async (drop: DropInfo) => {
    const key = drop.id.toString();
    if (!account || !connectedEvm) {
      setBuyByDrop((current) => ({
        ...current,
        [key]: { status: "error", message: "Connect the Polkadot wallet before buying." },
      }));
      return;
    }

    setBuyByDrop((current) => ({
      ...current,
      [key]: { status: "working", message: "Re-reading buyer status and preparing the device key..." },
    }));
    try {
      const readClient = await getReadClient();
      const alreadyBuyer = await readClient.isBuyer(drop.id, connectedEvm);
      const registeredPublicKey = alreadyBuyer
        ? await readClient.encKeyOf(drop.id, connectedEvm)
        : undefined;
      const keyResolution = await loadOrCreateDropsEncryptionKey(
        connectedEvm,
        alreadyBuyer,
        registeredPublicKey,
      );
      if (keyResolution.status === "missing-paid-key") {
        setLocalKeyByDrop((current) => ({ ...current, [key]: "missing" }));
        throw new Error("This address already paid, but its original device key is missing. A replacement key cannot repair the purchase.");
      }
      setLocalKeyByDrop((current) => ({ ...current, [key]: "available" }));

      setBuyByDrop((current) => ({
        ...current,
        [key]: { status: "working", message: "Checking the signing account balance..." },
      }));
      const balance = await getAssetHubBalance(account.address);
      const payment = contractPriceToSdkValue(drop.price);
      const required = payment + BUY_GAS_RESERVE_SDK;
      if (balance.spendable < required) {
        setBuyByDrop((current) => ({
          ...current,
          [key]: {
            status: "error",
            insufficientFunds: true,
            message: `This signing account has ${formatSdkPas(balance.spendable)} available. It needs at least ${formatSdkPas(required)}: ${formatSdkPas(payment)} for the price plus a 0.1 PAS gas reserve.`,
          },
        }));
        return;
      }

      const writeClient = await createDropsContractClient(account);
      const result = await writeClient.buy(
        drop.id,
        keyResolution.key.publicKeyRaw,
        drop.price,
        {
          onStatus: (status) => setBuyByDrop((current) => ({
            ...current,
            [key]: { status: "working", message: `Transaction: ${status}` },
          })),
        },
      );
      setBuyByDrop((current) => ({
        ...current,
        [key]: { status: "done", txHash: result.txHash },
      }));
      setBuyerByDrop((current) => ({ ...current, [key]: true }));
      await refresh();
    } catch (nextError) {
      setBuyByDrop((current) => ({
        ...current,
        [key]: { status: "error", message: friendlyBuyError(nextError) },
      }));
    }
  }, [account, connectedEvm, getReadClient, refresh]);

  const createDrop = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!account || !isOwner) {
      setCreateState({ status: "error", message: "Connect the contract owner account first." });
      return;
    }
    if (!publisherReady) {
      setCreateState({
        status: "error",
        message: "Wait until publisher Bulletin authorization is ready.",
      });
      return;
    }
    setCreateState({ status: "working", message: "Validating drop details..." });
    setCreatedDrop(null);
    try {
      const name = createName.trim();
      if (!name) throw new Error("Public announced name is required.");
      const price = parsePasPrice(createPrice);
      if (!createDeadline) throw new Error("Payment deadline is required.");
      const deadlineMs = new Date(createDeadline).getTime();
      if (!Number.isFinite(deadlineMs)) throw new Error("Payment deadline is invalid.");
      const deadline = BigInt(Math.floor(deadlineMs / 1000));
      if (deadline <= BigInt(Math.floor(Date.now() / 1000))) {
        throw new Error("Payment deadline must be in the future.");
      }
      const client = await createDropsContractClient(account);
      const result = await client.createDrop(name, price, deadline, {
        onStatus: (status) => setCreateState({ status: "working", message: `Transaction: ${status}` }),
      });
      const createdId = (await client.dropCount()).toString();
      setCreateState({ status: "done", message: `Drop created. Transaction ${result.txHash}` });
      setCreatedDrop({ id: createdId, title: name });
      setCreateName("");
      setCreateDeadline("");
      await refresh();
    } catch (nextError) {
      setCreateState({ status: "error", message: friendlyOwnerError(nextError) });
    }
  }, [account, createDeadline, createName, createPrice, isOwner, publisherReady, refresh]);

  const publishDrop = useCallback(async (drop: DropInfo) => {
    const key = drop.id.toString();
    if (!account || !isOwner) return;
    let retry = retryByDrop[key];
    let newContentKey: Uint8Array | null = null;
    setPublishByDrop((current) => ({
      ...current,
      [key]: { status: "working", message: retry ? "Resuming from the retained Bulletin CID..." : "Checking Bulletin authorization..." },
    }));

    try {
      if (!retry) {
        const file = fileByDrop[key];
        if (!file) throw new Error("Choose one file to publish.");
        const estimatedSize = estimateBlobSize(file);
        if (estimatedSize > MAX_UPLOAD_SIZE) {
          throw new Error(`Encrypted blob is approximately ${formatBytes(BigInt(estimatedSize))}, above the ${formatBytes(BigInt(MAX_UPLOAD_SIZE))} upload limit.`);
        }

        const allowance = await ensureAccountBulletinReady(
          account.address,
          (message) => setPublishByDrop((current) => ({
            ...current,
            [key]: { status: "working", message },
          })),
        );
        setKnownBulletinAllowance(account.address, allowance);
        setBulletinResultAddress(account.address);

        setPublishByDrop((current) => ({
          ...current,
          [key]: { status: "working", message: "Reading registered buyer keys..." },
        }));
        const readClient = await getReadClient();
        const buyerKeys = await readClient.buyerKeys(drop.id);

        const fileBytes = new Uint8Array(await file.arrayBuffer());
        newContentKey = generateContentKey();
        const iv = randomBytes(12);
        const meta: ProofyInnerMeta = {
          name: file.name,
          type: file.type || "application/octet-stream",
          size: file.size,
          createdAt: new Date().toISOString(),
        };
        setPublishByDrop((current) => ({
          ...current,
          [key]: { status: "working", message: "Encrypting the PRFY1 blob locally..." },
        }));
        const inner = encodeInner(meta, fileBytes);
        const ciphertext = await aesGcmEncrypt(newContentKey, iv, inner);
        const blob = encodeBlob(buildHeader(iv), ciphertext);
        if (blob.length > MAX_UPLOAD_SIZE) {
          throw new Error(`Encrypted blob is ${formatBytes(BigInt(blob.length))}, above the ${formatBytes(BigInt(MAX_UPLOAD_SIZE))} upload limit.`);
        }
        const stored = await storeBlob(blob, account.polkadotSigner, (message) => setPublishByDrop((current) => ({
          ...current,
          [key]: { status: "working", message },
        })));
        void refreshBulletinAllowance(false, true).catch(() => undefined);
        retry = {
          cid: stored.cid,
          contentKey: newContentKey,
          buyers: buyerKeys.buyers,
          publicKeys: buyerKeys.publicKeys,
          blobSize: blob.length,
        };
        newContentKey = null;
        setRetryByDrop((current) => ({ ...current, [key]: retry }));
      }

      if (!retry) throw new Error("Publication retry state is unavailable.");
      setPublishByDrop((current) => ({
        ...current,
        [key]: { status: "working", message: `Wrapping the content key for ${retry!.buyers.length} buyer(s)...` },
      }));
      const envelopes = await Promise.all(
        retry.buyers.map((_, index) =>
          wrapContentKey(retry!.contentKey, retry!.publicKeys[index], drop.id),
        ),
      );
      const writeClient = await createDropsContractClient(account);
      for (let offset = 0; offset < retry.buyers.length; offset += ENVELOPE_BATCH_SIZE) {
        const batchNumber = Math.floor(offset / ENVELOPE_BATCH_SIZE) + 1;
        const batchTotal = Math.ceil(retry.buyers.length / ENVELOPE_BATCH_SIZE);
        setPublishByDrop((current) => ({
          ...current,
          [key]: { status: "working", message: `Signing envelope batch ${batchNumber} of ${batchTotal}...` },
        }));
        await writeClient.addEnvelopes(
          drop.id,
          retry.buyers.slice(offset, offset + ENVELOPE_BATCH_SIZE),
          envelopes.slice(offset, offset + ENVELOPE_BATCH_SIZE),
        );
      }

      setPublishByDrop((current) => ({
        ...current,
        [key]: { status: "working", message: "Verifying every buyer envelope on-chain before publication..." },
      }));
      for (let index = 0; index < retry.buyers.length; index += 1) {
        const storedEnvelope = await writeClient.envelopeOf(
          drop.id,
          retry.buyers[index],
        );
        if (!bytesEqual(storedEnvelope, envelopes[index])) {
          throw new Error(
            `Envelope verification failed for buyer ${index + 1}. The CID was not published.`,
          );
        }
      }

      setPublishByDrop((current) => ({
        ...current,
        [key]: { status: "working", message: "Publishing the retained Bulletin CID..." },
      }));
      const result = await writeClient.publish(drop.id, retry.cid);
      retry.contentKey.fill(0);
      setRetryByDrop((current) => ({ ...current, [key]: undefined }));
      setPublishByDrop((current) => ({
        ...current,
        [key]: { status: "done", message: `Published. Transaction ${result.txHash}` },
      }));
      setFileByDrop((current) => ({ ...current, [key]: undefined }));
      await refresh();
    } catch (nextError) {
      if (newContentKey) newContentKey.fill(0);
      if (recoverTimedOutBulletinTransport(account.address, nextError)) return;
      setPublishByDrop((current) => ({
        ...current,
        [key]: { status: "error", message: friendlyOwnerError(nextError) },
      }));
    }
  }, [account, fileByDrop, getReadClient, isOwner, refresh, refreshBulletinAllowance, retryByDrop, setKnownBulletinAllowance]);

  const openDrop = useCallback(async (drop: DropInfo) => {
    const key = drop.id.toString();
    const client = clientRef.current;
    if (!client || !drop.cid) return;
    if (!connectedEvm) {
      setOpenByDrop((current) => ({
        ...current,
        [key]: {
          status: "unreadable",
          message: "Connect the wallet that bought this drop before opening it.",
        },
      }));
      return;
    }
    setOpenByDrop((current) => ({
      ...current,
      [key]: { status: "loading", message: "Checking the purchase and its registered key..." },
    }));

    let localKey = null;
    let isBuyer = false;
    let envelope: Uint8Array | null = null;
    try {
      isBuyer = await client.isBuyer(drop.id, connectedEvm);
      setBuyerByDrop((current) => ({ ...current, [key]: isBuyer }));
      if (isBuyer) {
        const registeredPublicKey = await client.encKeyOf(
          drop.id,
          connectedEvm,
        );
        localKey = await loadDropsEncryptionKeyForPublicKey(
          connectedEvm,
          registeredPublicKey,
        );
        if (!localKey) {
          setLocalKeyByDrop((current) => ({ ...current, [key]: "missing" }));
          setOpenByDrop((current) => ({
            ...current,
            [key]: {
              status: "lost-key",
              message: `The purchase is valid and the contract contains an envelope, but this Desktop does not have the private key registered for it (${publicKeyLabel(registeredPublicKey)}...). Re-pairing or replacing it cannot decrypt this already-published drop.`,
            },
          }));
          return;
        }
        setLocalKeyByDrop((current) => ({ ...current, [key]: "available" }));
        envelope = await client.envelopeOf(drop.id, connectedEvm);
        if (envelope.length === 0) {
          setOpenByDrop((current) => ({
            ...current,
            [key]: {
              status: "unreadable",
              message: "The purchase is valid, but the publisher did not store an envelope for this buyer before publishing the CID.",
            },
          }));
          return;
        }
      }
    } catch (nextError) {
      setOpenByDrop((current) => ({
        ...current,
        [key]: {
          status: "unreadable",
          message: `The contract access check failed. ${messageOf(nextError)}`,
        },
      }));
      return;
    }

    let storedBlob: Uint8Array;
    try {
      setOpenByDrop((current) => ({
        ...current,
        [key]: { status: "loading", message: "Downloading the complete public encrypted blob..." },
      }));
      storedBlob = await fetchBlobByCid(drop.cid, {
        onDiagnostic: (message) => console.info(`[Drops CID ${drop.cid}] ${message}`),
      });
    } catch (nextError) {
      setOpenByDrop((current) => ({
        ...current,
        [key]: {
          status: "unreadable",
          message: `The Bulletin blob could not be downloaded. ${messageOf(nextError)}`,
        },
      }));
      return;
    }

    if (isBuyer) {
      setOpenByDrop((current) => ({
        ...current,
        [key]: { status: "loading", message: "Opening the verified buyer envelope and decrypting locally..." },
      }));
    }

    try {
      const decoded = decodeBlob(storedBlob);

      let contentKey: Uint8Array;
      if (isBuyer && localKey && envelope) {
        contentKey = await unwrapContentKey(
          envelope,
          localKey.publicKeyRaw,
          localKey.privateKeyJwk,
          drop.id,
        );
      } else {
        // A non-buyer still receives every byte. AES-GCM authentication is the
        // only gate: this deliberate wrong-key attempt demonstrates that fact.
        contentKey = new Uint8Array(32);
      }

      const plain = await aesGcmDecrypt(
        contentKey,
        base64ToBytes(decoded.header.iv),
        decoded.ciphertext,
      );
      const inner = decodeInner(plain);
      const objectUrl = createDocumentUrl(inner.meta, inner.content);
      objectUrlsRef.current.add(objectUrl);
      setOpenByDrop((current) => {
        const previous = current[key];
        if (previous?.status === "ready") {
          URL.revokeObjectURL(previous.document.objectUrl);
          objectUrlsRef.current.delete(previous.document.objectUrl);
        }
        return {
          ...current,
          [key]: {
            status: "ready",
            document: { meta: inner.meta, content: inner.content, objectUrl },
          },
        };
      });
    } catch (nextError) {
      const detail = messageOf(nextError);
      setOpenByDrop((current) => ({
        ...current,
        [key]: {
          status: "unreadable",
          message: isBuyer
            ? `The Bulletin blob and matching local buyer key were found, but envelope or file authentication failed. ${detail}`
            : "The complete public blob was downloaded, but its bytes are unreadable without a buyer key. No server made this decision; AES-GCM authentication did.",
        },
      }));
    }
  }, [connectedEvm]);

  const publishedCount = useMemo(
    () => drops.filter((drop) => drop.published).length,
    [drops],
  );

  return (
    <main className="shell story-page drops-page">
      <Nav />
      <header className="story-hero drops-hero">
        <div className="story-kicker">Public bytes / private access</div>
        <h1>Private Drops</h1>
        <p className="story-lede">
          Payments, buyer keys and envelopes are public on Asset Hub. Files are
          public on Bulletin. Only cryptography decides who can read them.
        </p>
        {!focusedDropId && <OpenDropLinkForm compact />}
        <div className="drops-toolbar">
          {connectedSs58 ? (
            <span className="btn btn-ink wallet-connected-badge">Wallet connected</span>
          ) : (
            <button
              className="btn btn-ink"
              type="button"
              disabled={walletStatus === "connecting"}
              onClick={connect}
            >
              {walletStatus === "connecting" ? "Connecting..." : "Connect Polkadot wallet"}
            </button>
          )}
          <button
            className="btn btn-ghost"
            type="button"
            disabled={loading || (!selectedAddress && !focusedDropId)}
            onClick={() => {
              void refresh();
              if (selectedAddress && !focusedDropId) startPublisherDiscovery(selectedAddress, true);
            }}
          >
            Refresh drops
          </button>
        </div>
        {connectedSs58 && (
          <div className="drops-identity">
            <p>Signing account</p>
            <AddressRow address={connectedSs58} />
            <p>
              Contract address <code>{connectedEvm}</code>
            </p>
            <p>
              {currentAccountRole.status === "checking"
                ? "Buyer actions ready. Checking publisher role..."
                : currentAccountRole.status === "owner"
                  ? "Publisher account confirmed."
                  : currentAccountRole.status === "error"
                    ? `Buyer actions ready. Publisher check failed: ${currentAccountRole.message}`
                    : "Buyer actions ready."}
            </p>
          </div>
        )}
      </header>

      {isOwner && !focusedDropId && (
        <section className="drops-owner-panel">
          <div className="story-kicker">Owner account</div>
          <h2>Publisher controls</h2>
          <p>Create a public sale announcement. The real file name remains encrypted inside the later PRFY1 blob and does not need to match this name.</p>
          <div className={`drops-bulletin-status${bulletinAllowanceError || bulletinState.status === "error" ? " is-error" : ""}`}>
            <div>
              <strong>Bulletin storage</strong>
              {bulletinState.status === "working" ? (
                <span>{bulletinState.message}</span>
              ) : checkingBulletinAllowance ? (
                <span>Checking on-chain authorization...</span>
              ) : bulletinState.status === "error" ? (
                <span>{bulletinState.message}</span>
              ) : bulletinAllowanceError ? (
                <span>{bulletinAllowanceError}</span>
              ) : bulletinAllowance?.usable ? (
                <span>
                  Authorization active
                  {bulletinAllowance.expiresAtBlock !== undefined && `; expires at block ${formatNumber(bulletinAllowance.expiresAtBlock)}`}
                  {bulletinAllowance.remainingBlocks !== undefined && ` (${formatNumber(bulletinAllowance.remainingBlocks)} blocks left)`}. Soft-priority counters: {formatNumber(bulletinAllowance.remainingTransactions)} transaction(s), {formatBytes(bulletinAllowance.remainingBytes)}.
                </span>
              ) : bulletinAllowance?.expired ? (
                <span>Authorization expired.</span>
              ) : bulletinAllowance === undefined ? (
                <span>Bulletin authorization has not been checked yet.</span>
              ) : (
                <span>No Bulletin authorization is available for this account.</span>
              )}
            </div>
          </div>
          <BulletinBalanceNotice address={account?.address ?? null} />
          <form className="drops-owner-form" onSubmit={createDrop}>
            <label>
              Public announced name
              <input
                type="text"
                value={createName}
                onChange={(event) => setCreateName(event.target.value)}
                placeholder="Quarterly research note"
                required
              />
            </label>
            <label>
              Price in PAS
              <input
                type="text"
                inputMode="decimal"
                value={createPrice}
                onChange={(event) => setCreatePrice(event.target.value)}
                placeholder="1"
                required
              />
            </label>
            <label>
              Payment deadline
              <input
                type="datetime-local"
                value={createDeadline}
                onChange={(event) => setCreateDeadline(event.target.value)}
                required
              />
            </label>
            <button className="btn btn-pink" type="submit" disabled={!publisherReady || createState.status === "working"}>
              {createState.status === "working"
                ? "Creating..."
                : publisherReady
                  ? "Create drop"
                  : "Waiting for Bulletin..."}
            </button>
          </form>
          {createState.status !== "idle" && (
            <p className={createState.status === "error" ? "drops-open-error" : "drops-open-status"} role={createState.status === "error" ? "alert" : undefined}>
              {createState.message}
            </p>
          )}
          {createState.status === "done" && createdDrop && (
            <DropShareActions
              dropId={createdDrop.id}
            />
          )}
        </section>
      )}

      <section className="drops-public-note">
        <strong>Nothing here is hidden.</strong>
        <span>Every address, public key, envelope, CID and encrypted blob is world-readable. A buyer&apos;s local device key is the only private piece.</span>
      </section>

      {error && <p className="drops-error" role="alert">{error}</p>}

      <section className="drops-list" aria-busy={loading}>
        <div className="drops-list-heading">
          <div>
            <span className="story-kicker">Devnet contract</span>
            <h2>{focusedDropId ? "Drop details" : "Available drops"}</h2>
          </div>
          {!focusedDropId && <span>{drops.length} total / {publishedCount} published</span>}
        </div>

        {!focusedDropId && !selectedAddress && <p className="drops-empty">Connect the wallet to load available drops.</p>}
        {loading && drops.length === 0 && (selectedAddress || focusedDropId) && <p className="drops-empty">Reading public contract state...</p>}
        {!focusedDropId && selectedAddress && !loading && drops.length === 0 && <p className="drops-empty">No drops have been created yet.</p>}
        {focusedDropId && !loading && focusedDropMissing && <p className="drops-empty">Drop #{focusedDropId} was not found.</p>}

        {drops.map((drop) => {
          const key = drop.id.toString();
          const isBuyer = buyerByDrop[key] === true;
          const checkingBuyerAccess = Boolean(
            account && buyerResultEvm !== connectedEvm,
          );
          const missingPaidKey = isBuyer && localKeyByDrop[key] === "missing";
          const buyState = buyByDrop[key] ?? { status: "idle" as const };
          const openState = openByDrop[key] ?? { status: "idle" as const };
          const publishState = publishByDrop[key] ?? { status: "idle" as const };
          const retry = retryByDrop[key];
          const selectedFile = fileByDrop[key];
          const inSale = !drop.published && BigInt(now) < drop.payDeadline;
          const closed = !drop.published && !inSale;
          return (
            <article className="drops-card" key={key}>
              <div className="drops-card-topline">
                <span>Drop #{key}</span>
                <span className={`drops-state ${drop.published ? "published" : inSale ? "sale" : "closed"}`}>
                  {drop.published ? "Published" : inSale ? "In sale" : "Awaiting publication"}
                </span>
              </div>
              <h2>{drop.name}</h2>
              <DropShareActions dropId={key} compact />
              <dl className="drops-facts">
                <div><dt>Price</dt><dd>{formatPas(drop.price)}</dd></div>
                <div><dt>Payment deadline</dt><dd>{formatDeadline(drop.payDeadline)}</dd></div>
                <div><dt>Buyers</dt><dd>{drop.buyerCount.toString()}</dd></div>
              </dl>

              {inSale && (
                <div className="drops-card-message">
                  <strong>{countdown(drop.payDeadline, now)}</strong>
                  {checkingBuyerAccess ? (
                    <p>Checking whether this wallet already owns access...</p>
                  ) : missingPaidKey ? (
                    <p className="drops-inline-danger">This address paid, but its original local encryption key is missing. Do not create a replacement; it cannot open the future envelope.</p>
                  ) : isBuyer ? (
                    <p>Access purchased. The file becomes available shortly after the payment deadline.</p>
                  ) : (
                    <>
                      <p><strong>Before buying:</strong> access is bound to this device and cannot be backed up or recovered.</p>
                      <button
                        className="btn btn-pink drops-buy-button"
                        type="button"
                        disabled={buyState.status === "working" || walletStatus === "connecting"}
                        onClick={() => account ? void buyDrop(drop) : void connect()}
                      >
                        {buyState.status === "working"
                          ? "Buying..."
                          : walletStatus === "connecting"
                            ? "Connecting..."
                            : "Buy access"}
                      </button>
                      {!account && <small>Connect the Polkadot wallet above to buy.</small>}
                    </>
                  )}
                  {buyState.status === "working" && <p className="drops-open-status">{buyState.message}</p>}
                  {buyState.status === "done" && <p className="drops-buy-success">Access purchased. Transaction <code>{buyState.txHash}</code></p>}
                  {buyState.status === "error" && (
                    <div className="drops-open-error" role="alert">
                      {buyState.message}
                      {buyState.insufficientFunds && account && (
                        <p>
                          Request funds for SS58 <code>{account.address}</code> from the{" "}
                          <a href="https://faucet.polkadot.io/paseo?parachain=1000" target="_blank" rel="noreferrer">Paseo Asset Hub 1000 faucet</a>. More than the listed price is required because gas is separate.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {closed && (
                <div className="drops-card-message">
                  <strong>Sale closed</strong>
                  {missingPaidKey ? (
                    <p className="drops-inline-danger">This address paid, but its device key is missing. This drop cannot be opened and the payment is not recoverable.</p>
                  ) : (
                    <p>The file becomes available shortly after the payment deadline, once the owner publishes it.</p>
                  )}
                </div>
              )}

              {isOwner && !focusedDropId && closed && (
                <div className="drops-publish-panel">
                  <div>
                    <span className="story-kicker">Owner publication</span>
                    <h3>Encrypt and publish</h3>
                  </div>
                  {retry ? (
                    <div className="drops-retry-cid">
                      <strong>Upload retained for retry</strong>
                      <code>{retry.cid}</code>
                      <small>{formatBytes(BigInt(retry.blobSize))} encrypted / {retry.buyers.length} buyer(s). Do not reload this page until publication succeeds.</small>
                    </div>
                  ) : (
                    <label
                      className="drops-file-field"
                      onClick={notifyFilePickerAttempt}
                    >
                      Choose the real file
                      <input
                        type="file"
                        accept="*/*"
                        onClick={notifyFilePickerAttempt}
                        onChange={(event) => setFileByDrop((current) => ({
                          ...current,
                          [key]: event.target.files?.[0],
                        }))}
                      />
                      {selectedFile && (
                        <small>{selectedFile.name} / approximately {formatBytes(BigInt(estimateBlobSize(selectedFile)))} encrypted</small>
                      )}
                    </label>
                  )}
                  {showAndroidNotice && (
                    <p className="drops-open-error" role="alert">
                      File selection currently only works reliably on iPhone
                      and Desktop. If no picker opened, this is a known
                      Android limitation we&apos;re tracking, not a problem
                      with your file.
                    </p>
                  )}
                  {selectedFile && estimateBlobSize(selectedFile) > MAX_UPLOAD_SIZE && (
                    <p className="drops-open-error" role="alert">
                      This encrypted blob is about{" "}
                      {formatBytes(BigInt(estimateBlobSize(selectedFile)))}. The
                      upload limit is {formatBytes(BigInt(MAX_UPLOAD_SIZE))}.
                    </p>
                  )}
                  <div className="actions-row">
                    <button
                      className="btn btn-ink"
                      type="button"
                      disabled={
                        publishState.status === "working" ||
                        (!selectedFile && !retry) ||
                        (selectedFile != null &&
                          estimateBlobSize(selectedFile) > MAX_UPLOAD_SIZE)
                      }
                      onClick={() => void publishDrop(drop)}
                    >
                      {publishState.status === "working" ? "Publishing..." : retry ? "Retry envelopes / publish" : "Publish file"}
                    </button>
                  </div>
                  {publishState.status !== "idle" && (
                    <div className={publishState.status === "error" ? "drops-open-error" : "drops-open-status"} role={publishState.status === "error" ? "alert" : undefined}>
                      {publishState.message}
                      {retry && publishState.status === "error" && <p>The Bulletin upload will not be repeated. Use the retry button above.</p>}
                    </div>
                  )}
                </div>
              )}

              {drop.published && (
                <div className="drops-published">
                  <div className="drops-cid">
                    <span>Public Bulletin CID</span>
                    <code>{drop.cid}</code>
                  </div>
                  <div className="actions-row">
                    <button className="btn btn-pink" type="button" disabled={openState.status === "loading"} onClick={() => void openDrop(drop)}>
                      {openState.status === "loading" ? "Opening..." : "Open file"}
                    </button>
                  </div>

                  {openState.status === "loading" && <p className="drops-open-status">{openState.message}</p>}
                  {openState.status === "lost-key" && (
                    <p className="drops-open-error" role="alert">
                      {openState.message}
                    </p>
                  )}
                  {openState.status === "unreadable" && <p className="drops-open-error" role="alert">{openState.message}</p>}
                  {openState.status === "ready" && (
                    <DropDocumentPreview
                      document={openState.document}
                      downloadError={openState.downloadError}
                      onDownloadError={(downloadError) => setOpenByDrop((current) => ({
                        ...current,
                        [key]: { ...openState, downloadError },
                      }))}
                    />
                  )}
                </div>
              )}
            </article>
          );
        })}
      </section>
    </main>
  );
}

function DropDocumentPreview({
  document,
  downloadError,
  onDownloadError,
}: {
  document: RecoveredDocument;
  downloadError?: string;
  onDownloadError: (message?: string) => void;
}) {
  const [copyStatus, setCopyStatus] = useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);
  const kind = documentPreviewKind(document);
  const text = kind === "text"
    ? new TextDecoder("utf-8", { fatal: false }).decode(document.content)
    : null;
  return (
    <div className="drops-document">
      <div className="drops-document-meta">
        <strong>{document.meta.name}</strong>
        <span>{document.meta.type || "application/octet-stream"} / {document.meta.size} bytes</span>
      </div>
      {kind === "image" && (
        // The decrypted Blob URL never leaves this browser.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={document.objectUrl} alt={`Preview of ${document.meta.name}`} />
      )}
      {kind === "pdf" && <iframe src={document.objectUrl} title={`Preview of ${document.meta.name}`} sandbox="" />}
      {kind === "text" && <pre>{text}</pre>}
      {kind === "unavailable" && <p>This file type cannot be previewed safely.</p>}
      <button className="btn btn-pink" type="button" onClick={() => {
        setCopyStatus(null);
        void copyDocument(document)
          .then((copiedKind) => setCopyStatus({
            kind: "success",
            message: copiedKind === "image"
              ? "Image copied. Paste it into a message, email, notes, or another app."
              : copiedKind === "text"
                ? "Document text copied to the clipboard."
                : "Document copied to the clipboard.",
          }))
          .catch((error) => setCopyStatus({
            kind: "error",
            message: messageOf(error),
          }));
      }}>Copy document</button>
      <button className="btn btn-ink desktop-file-action" type="button" onClick={() => {
        onDownloadError(undefined);
        void downloadDocument(document).catch((error) => onDownloadError(messageOf(error)));
      }}>Save / share document</button>
      {copyStatus && (
        <p className={copyStatus.kind === "error" ? "drops-open-error" : "drops-open-status"}>
          {copyStatus.message}
        </p>
      )}
      {downloadError && <p className="drops-open-error">{downloadError}</p>}
    </div>
  );
}
