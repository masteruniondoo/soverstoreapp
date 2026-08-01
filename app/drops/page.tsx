"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MAX_FILE_SIZE } from "@parity/bulletin-sdk";
import { ss58ToH160 } from "@parity/product-sdk/address";
import { Nav } from "@/components/Nav";
import {
  buildHeader,
  decodeBlob,
  decodeInner,
  encodeBlob,
  encodeInner,
  estimateBlobSize,
  type ProofyInnerMeta,
} from "@/lib/blob/format";
import {
  fetchAllowance,
  requestAllowance,
  storeBlob,
  type Allowance,
} from "@/lib/bulletin";
import {
  BULLETIN_IPFS_GATEWAY,
  fetchBlobByCid,
} from "@/lib/bulletin/retrieve";
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
  loadDropsEncryptionKey,
  loadOrCreateDropsEncryptionKey,
} from "@/lib/drops/keys";
import {
  createDocumentUrl,
  documentPreviewKind,
  downloadDocument,
  type RecoveredDocument,
} from "@/lib/recovered-document";
import {
  connectHostWallet,
  type AppWalletAccount,
} from "@/lib/wallet";
import { formatBytes } from "@/lib/format";

type OpenState =
  | { status: "idle" }
  | { status: "loading"; message: string }
  | { status: "lost-key" }
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
  | { status: "needs-allowance"; message: string }
  | { status: "error"; message: string }
  | { status: "done"; message: string };

type PublishRetry = {
  cid: string;
  contentKey: Uint8Array;
  buyers: string[];
  publicKeys: Uint8Array[];
  blobSize: number;
};

const ENVELOPE_BATCH_SIZE = 20;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function rawBlobUrl(cid: string): string {
  return `${BULLETIN_IPFS_GATEWAY.replace(/\/$/, "")}/ipfs/${cid}`;
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
  const [drops, setDrops] = useState<DropInfo[]>([]);
  const [owner, setOwner] = useState("");
  const [account, setAccount] = useState<AppWalletAccount | null>(null);
  const [connectedSs58, setConnectedSs58] = useState("");
  const [connectedEvm, setConnectedEvm] = useState("");
  const [buyerByDrop, setBuyerByDrop] = useState<Record<string, boolean>>({});
  const [localKeyState, setLocalKeyState] = useState<"unknown" | "available" | "missing">("unknown");
  const [buyByDrop, setBuyByDrop] = useState<Record<string, BuyState>>({});
  const [createName, setCreateName] = useState("");
  const [createPrice, setCreatePrice] = useState("1");
  const [createDeadline, setCreateDeadline] = useState("");
  const [createState, setCreateState] = useState<OwnerActionState>({ status: "idle" });
  const [fileByDrop, setFileByDrop] = useState<Record<string, File | undefined>>({});
  const [publishByDrop, setPublishByDrop] = useState<Record<string, OwnerActionState>>({});
  const [retryByDrop, setRetryByDrop] = useState<Record<string, PublishRetry | undefined>>({});
  const [openByDrop, setOpenByDrop] = useState<Record<string, OpenState>>({});
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const clientRef = useRef<DropsContractClient | null>(null);
  const objectUrlsRef = useRef(new Set<string>());

  const isOwner =
    connectedEvm !== "" && owner.toLowerCase() === connectedEvm.toLowerCase();

  const updateBuyerStatus = useCallback(
    async (client: DropsContractClient, evm: string, currentDrops: DropInfo[]) => {
      const entries = await Promise.all(
        currentDrops.map(async (drop) => [
          drop.id.toString(),
          await client.isBuyer(drop.id, evm),
        ] as const),
      );
      const statuses = Object.fromEntries(entries);
      setBuyerByDrop(statuses);
      if (Object.values(statuses).some(Boolean)) {
        try {
          setLocalKeyState(await loadDropsEncryptionKey() ? "available" : "missing");
        } catch {
          setLocalKeyState("missing");
        }
      }
    },
    [],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const client = clientRef.current ?? await createDropsContractClient();
      clientRef.current = client;
      const [nextOwner, count] = await Promise.all([
        client.owner(),
        client.dropCount(),
      ]);
      const ids = Array.from(
        { length: Number(count) },
        (_, index) => count - BigInt(index),
      );
      const nextDrops = await Promise.all(ids.map((id) => client.dropInfo(id)));
      setOwner(nextOwner);
      setDrops(nextDrops);
      if (connectedEvm) {
        await updateBuyerStatus(client, connectedEvm, nextDrops);
      }
    } catch (nextError) {
      setError(messageOf(nextError));
    } finally {
      setLoading(false);
    }
  }, [connectedEvm, updateBuyerStatus]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const [account] = await connectHostWallet();
      if (!account) throw new Error("Host wallet returned no account.");
      const evm = ss58ToH160(account.address);
      setAccount(account);
      setConnectedSs58(account.address);
      setConnectedEvm(evm);
      const client = clientRef.current ?? await createDropsContractClient();
      clientRef.current = client;
      await updateBuyerStatus(client, evm, drops);
    } catch (nextError) {
      setError(messageOf(nextError));
    } finally {
      setConnecting(false);
    }
  }, [drops, updateBuyerStatus]);

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
      const readClient = clientRef.current ?? await createDropsContractClient();
      clientRef.current = readClient;
      const alreadyBuyer = await readClient.isBuyer(drop.id, connectedEvm);
      const keyResolution = await loadOrCreateDropsEncryptionKey(alreadyBuyer);
      if (keyResolution.status === "missing-paid-key") {
        setLocalKeyState("missing");
        throw new Error("This address already paid, but its original device key is missing. A replacement key cannot repair the purchase.");
      }
      setLocalKeyState("available");

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
  }, [account, connectedEvm, refresh]);

  const createDrop = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!account || !isOwner) {
      setCreateState({ status: "error", message: "Connect the contract owner account first." });
      return;
    }
    setCreateState({ status: "working", message: "Validating drop details..." });
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
      setCreateState({ status: "done", message: `Drop created. Transaction ${result.txHash}` });
      setCreateName("");
      setCreateDeadline("");
      await refresh();
    } catch (nextError) {
      setCreateState({ status: "error", message: friendlyOwnerError(nextError) });
    }
  }, [account, createDeadline, createName, createPrice, isOwner, refresh]);

  const authorizeBulletin = useCallback(async (drop: DropInfo) => {
    const key = drop.id.toString();
    if (!account || !isOwner) return;
    setPublishByDrop((current) => ({
      ...current,
      [key]: { status: "working", message: "Preparing Devnet Bulletin authorization..." },
    }));
    try {
      await requestAllowance(account.address, (message) => setPublishByDrop((current) => ({
        ...current,
        [key]: { status: "working", message },
      })));
      const allowance = await fetchAllowance(account.address);
      if (!allowance || allowance.expired) throw new Error("Bulletin authorization was not found after finalization.");
      setPublishByDrop((current) => ({ ...current, [key]: { status: "idle" } }));
    } catch (nextError) {
      setPublishByDrop((current) => ({
        ...current,
        [key]: { status: "error", message: messageOf(nextError) },
      }));
    }
  }, [account, isOwner]);

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
        if (estimatedSize > MAX_FILE_SIZE) {
          throw new Error(`Encrypted blob is approximately ${formatBytes(BigInt(estimatedSize))}, above the ${formatBytes(BigInt(MAX_FILE_SIZE))} limit.`);
        }

        const allowance: Allowance | null = await fetchAllowance(account.address);
        if (!allowance || allowance.expired) {
          setPublishByDrop((current) => ({
            ...current,
            [key]: { status: "needs-allowance", message: "This Product account needs a Devnet Bulletin storage authorization before upload." },
          }));
          return;
        }
        if (allowance.remainingBytes < BigInt(estimatedSize)) {
          setPublishByDrop((current) => ({
            ...current,
            [key]: { status: "needs-allowance", message: `The encrypted blob needs about ${formatBytes(BigInt(estimatedSize))}, but only ${formatBytes(allowance.remainingBytes)} remains.` },
          }));
          return;
        }

        setPublishByDrop((current) => ({
          ...current,
          [key]: { status: "working", message: "Reading registered buyer keys..." },
        }));
        const readClient = clientRef.current ?? await createDropsContractClient();
        clientRef.current = readClient;
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
        if (blob.length > MAX_FILE_SIZE) {
          throw new Error(`Encrypted blob is ${formatBytes(BigInt(blob.length))}, above the ${formatBytes(BigInt(MAX_FILE_SIZE))} limit.`);
        }

        const stored = await storeBlob(blob, account.polkadotSigner, (message) => setPublishByDrop((current) => ({
          ...current,
          [key]: { status: "working", message },
        })));
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
      setPublishByDrop((current) => ({
        ...current,
        [key]: { status: "error", message: friendlyOwnerError(nextError) },
      }));
    }
  }, [account, fileByDrop, isOwner, refresh, retryByDrop]);

  const openDrop = useCallback(async (drop: DropInfo) => {
    const key = drop.id.toString();
    const client = clientRef.current;
    if (!client || !drop.cid) return;
    const isBuyer = buyerByDrop[key] === true;
    setOpenByDrop((current) => ({
      ...current,
      [key]: { status: "loading", message: "Checking the local device key..." },
    }));

    let localKey = null;
    if (isBuyer) {
      try {
        localKey = await loadDropsEncryptionKey();
      } catch {
        setOpenByDrop((current) => ({ ...current, [key]: { status: "lost-key" } }));
        return;
      }
      if (!localKey) {
        setOpenByDrop((current) => ({ ...current, [key]: { status: "lost-key" } }));
        return;
      }
    }

    try {
      setOpenByDrop((current) => ({
        ...current,
        [key]: { status: "loading", message: "Downloading the complete public encrypted blob..." },
      }));
      const storedBlob = await fetchBlobByCid(drop.cid);
      const decoded = decodeBlob(storedBlob);

      let contentKey: Uint8Array;
      if (isBuyer && localKey && connectedEvm) {
        const envelope = await client.envelopeOf(drop.id, connectedEvm);
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
            ? `The public blob was downloaded, but this device could not authenticate the envelope or file. ${detail}`
            : "The complete public blob was downloaded, but its bytes are unreadable without a buyer key. No server made this decision; AES-GCM authentication did.",
        },
      }));
    }
  }, [buyerByDrop, connectedEvm]);

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
        <div className="drops-toolbar">
          <button className="btn btn-ink" type="button" disabled={connecting} onClick={connect}>
            {connecting ? "Connecting..." : connectedSs58 ? "Wallet connected" : "Connect Polkadot wallet"}
          </button>
          <button className="btn btn-ghost" type="button" disabled={loading} onClick={() => void refresh()}>
            Refresh drops
          </button>
        </div>
        {connectedSs58 && (
          <p className="drops-identity">
            Signing account <code>{connectedSs58}</code><br />
            Contract address <code>{connectedEvm}</code>
          </p>
        )}
      </header>

      {isOwner && (
        <section className="drops-owner-panel">
          <div className="story-kicker">Owner account</div>
          <h2>Publisher controls</h2>
          <p>Create a public sale announcement. The real file name remains encrypted inside the later PRFY1 blob and does not need to match this name.</p>
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
            <button className="btn btn-pink" type="submit" disabled={createState.status === "working"}>
              {createState.status === "working" ? "Creating..." : "Create drop"}
            </button>
          </form>
          {createState.status !== "idle" && (
            <p className={createState.status === "error" ? "drops-open-error" : "drops-open-status"} role={createState.status === "error" ? "alert" : undefined}>
              {createState.message}
            </p>
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
            <h2>Available drops</h2>
          </div>
          <span>{drops.length} total / {publishedCount} published</span>
        </div>

        {loading && drops.length === 0 && <p className="drops-empty">Reading public contract state...</p>}
        {!loading && drops.length === 0 && <p className="drops-empty">No drops have been created yet.</p>}

        {drops.map((drop) => {
          const key = drop.id.toString();
          const isBuyer = buyerByDrop[key] === true;
          const missingPaidKey = isBuyer && localKeyState === "missing";
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
              <dl className="drops-facts">
                <div><dt>Price</dt><dd>{formatPas(drop.price)}</dd></div>
                <div><dt>Payment deadline</dt><dd>{formatDeadline(drop.payDeadline)}</dd></div>
                <div><dt>Buyers</dt><dd>{drop.buyerCount.toString()}</dd></div>
              </dl>

              {inSale && (
                <div className="drops-card-message">
                  <strong>{countdown(drop.payDeadline, now)}</strong>
                  {missingPaidKey ? (
                    <p className="drops-inline-danger">This address paid, but its original local encryption key is missing. Do not create a replacement; it cannot open the future envelope.</p>
                  ) : isBuyer ? (
                    <p>Access purchased. The file becomes available shortly after the payment deadline.</p>
                  ) : (
                    <>
                      <p><strong>Before buying:</strong> access is bound to this device and cannot be backed up or recovered.</p>
                      <button
                        className="btn btn-pink drops-buy-button"
                        type="button"
                        disabled={!account || buyState.status === "working"}
                        onClick={() => void buyDrop(drop)}
                      >
                        {buyState.status === "working" ? "Buying..." : "Buy access"}
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

              {isOwner && closed && (
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
                    <label className="drops-file-field">
                      Choose the real file
                      <input
                        type="file"
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
                  <div className="actions-row">
                    <button
                      className="btn btn-ink"
                      type="button"
                      disabled={publishState.status === "working" || (!selectedFile && !retry)}
                      onClick={() => void publishDrop(drop)}
                    >
                      {publishState.status === "working" ? "Publishing..." : retry ? "Retry envelopes / publish" : "Publish file"}
                    </button>
                    {publishState.status === "needs-allowance" && (
                      <button className="btn btn-pink" type="button" onClick={() => void authorizeBulletin(drop)}>
                        Authorize Devnet storage
                      </button>
                    )}
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
                    <a className="text-link" href={rawBlobUrl(drop.cid)} target="_blank" rel="noreferrer">Download raw encrypted blob</a>
                  </div>

                  {openState.status === "loading" && <p className="drops-open-status">{openState.message}</p>}
                  {openState.status === "lost-key" && (
                    <p className="drops-open-error" role="alert">
                      This address bought the drop, but its encryption key is missing. It was created on another device or this Product&apos;s app data was cleared. The drop cannot be opened and the payment is not recoverable.
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
      <button className="btn btn-ink" type="button" onClick={() => {
        onDownloadError(undefined);
        void downloadDocument(document).catch((error) => onDownloadError(messageOf(error)));
      }}>Save / share document</button>
      {downloadError && <p className="drops-open-error">{downloadError}</p>}
    </div>
  );
}
