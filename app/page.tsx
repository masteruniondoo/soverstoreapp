"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BulletinError, MAX_FILE_SIZE } from "@parity/bulletin-sdk";
import { Nav } from "@/components/Nav";
import PreviewPage from "@/app/preview/page";
import {
  GRANT_BYTES,
  GRANT_TRANSACTIONS,
  fetchAllowance,
  getChainName,
  requestAllowance,
  storeBlob,
  type Allowance,
  type BlobStoreResult,
} from "@/lib/bulletin";
import {
  buildRecovery,
  downloadRecovery,
  type RecoveryV1,
} from "@/lib/artifacts/recovery";
import { downloadRecoveryQrCard } from "@/lib/artifacts/recovery-qr";
import {
  buildHeader,
  encodeBlob,
  encodeInner,
  estimateBlobSize,
  type ProofyInnerMeta,
} from "@/lib/blob/format";
import { aesGcmEncrypt } from "@/lib/crypto/aes";
import { randomBytes } from "@/lib/crypto/random";
import { formatBytes, formatNumber, shortAddress } from "@/lib/format";
import {
  connectHostWallet,
  type AppWalletAccount,
} from "@/lib/wallet";
import { BULLETIN_NETWORK_NAME } from "@/lib/runtime-config";

type ChainState =
  | { status: "connecting" }
  | { status: "ready"; name: string }
  | { status: "error" };

type StorageState =
  | "idle"
  | "encrypting"
  | "storing"
  | "done"
  | "failed";

type StorageResult = {
  store: BlobStoreResult;
  recovery: RecoveryV1;
  fileBaseName: string;
  authorAddress: string;
};

const INITIAL_AUTH_CHECK_ATTEMPTS = 12;
const INITIAL_AUTH_CHECK_DELAY_MS = 5_000;
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeBaseName(name: string): string {
  const trimmed = name.trim().replace(/\.[^/.]+$/, "");
  return (trimmed || "proofbox-file").replace(/[\\/:*?"<>|]+/g, "-");
}

function StorageHome() {
  const [chain, setChain] = useState<ChainState>({ status: "connecting" });

  const [accounts, setAccounts] = useState<AppWalletAccount[]>([]);
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);

  const [allowance, setAllowance] = useState<Allowance | null | undefined>(
    undefined,
  );
  const [checkingAllowance, setCheckingAllowance] = useState(false);

  const [busy, setBusy] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [storageState, setStorageState] = useState<StorageState>("idle");
  const [result, setResult] = useState<StorageResult | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allowanceError, setAllowanceError] = useState<string | null>(null);
  const [connectingHostWallet, setConnectingHostWallet] = useState(false);

  const walletConnected = selectedAddress != null;
  const authorized = allowance != null && !allowance.expired;
  const authorizationChecked = walletConnected && allowance !== undefined;
  const canCreateStorageAccount =
    authorizationChecked && !checkingAllowance && !authorized;
  const selectedAccount = accounts.find((a) => a.address === selectedAddress);
  const estimatedBlobSize = useMemo(
    () => (selectedFile ? estimateBlobSize(selectedFile) : null),
    [selectedFile],
  );
  const fileTooLarge =
    estimatedBlobSize != null && estimatedBlobSize > MAX_FILE_SIZE;
  const allowanceTooSmall =
    estimatedBlobSize != null &&
    allowance != null &&
    !allowance.expired &&
    allowance.remainingBytes < BigInt(estimatedBlobSize);
  const canUpload =
    selectedFile != null &&
    selectedAccount != null &&
    authorized &&
    !busy &&
    !fileTooLarge &&
    !allowanceTooSmall;

  useEffect(() => {
    let stop = false;
    getChainName()
      .then((name) => {
        if (!stop) setChain({ status: "ready", name });
      })
      .catch(() => {
        if (!stop) setChain({ status: "error" });
      });
    return () => {
      stop = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedAddress) {
      setAllowance(undefined);
      setAllowanceError(null);
      return;
    }
    setAllowance(undefined);
    setAllowanceError(null);
    let stop = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const readAllowance = async (retryMissing: boolean) => {
      let lastError: unknown;
      const attempts = retryMissing ? INITIAL_AUTH_CHECK_ATTEMPTS : 1;

      for (let attempt = 1; attempt <= attempts && !stop; attempt += 1) {
        try {
          const next = await fetchAllowance(selectedAddress);
          if (next != null || attempt === attempts || !retryMissing) {
            return next;
          }
        } catch (e) {
          lastError = e;
          if (attempt === attempts || !retryMissing) throw e;
        }

        await delay(INITIAL_AUTH_CHECK_DELAY_MS);
      }

      if (lastError) throw lastError;
      return null;
    };

    const load = async (showSpinner: boolean) => {
      if (showSpinner) setCheckingAllowance(true);
      try {
        const next = await readAllowance(showSpinner);
        if (!stop) {
          setAllowance(next);
          setAllowanceError(null);
        }
      } catch (e) {
        if (!stop) {
          setAllowance(undefined);
          setAllowanceError(
            e instanceof Error
              ? e.message
              : "Could not check Bulletin authorization.",
          );
        }
      } finally {
        if (!stop) setCheckingAllowance(false);
      }
    };

    load(true).finally(() => {
      if (!stop) timer = setInterval(() => load(false), 15_000);
    });

    return () => {
      stop = true;
      if (timer) clearInterval(timer);
    };
  }, [selectedAddress]);

  const connectWallet = useCallback(async () => {
    setError(null);
    setConnectingHostWallet(true);
    try {
      const found = await connectHostWallet();
      setAccounts(found);
      setSelectedAddress(found[0].address);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnectingHostWallet(false);
    }
  }, []);

  const createStorageAccount = useCallback(async () => {
    if (!selectedAddress || busy || !canCreateStorageAccount) return;
    setBusy(true);
    setError(null);
    setProgress("Requesting allowance from the TestNet faucet...");
    try {
      await requestAllowance(selectedAddress, setProgress);
      const next = await fetchAllowance(selectedAddress);
      setAllowance(next);
      setProgress("Allowance granted. Account authorized on Bulletin.");
    } catch (e) {
      setProgress(null);
      if (e instanceof BulletinError) {
        setError(`${e.message} - ${e.recoveryHint}`);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  }, [selectedAddress, busy, canCreateStorageAccount]);

  const selectFile = useCallback((file: File | null) => {
    setSelectedFile(file);
    setResult(null);
    setStorageState("idle");
    setProgress(null);
    setError(null);
  }, []);

  const dropFile = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (!authorized || busy) return;
      selectFile(event.dataTransfer.files?.[0] ?? null);
    },
    [authorized, busy, selectFile],
  );

  const uploadFile = useCallback(async () => {
    if (!selectedFile || !selectedAccount || !selectedAddress || !canUpload) {
      return;
    }

    setBusy(true);
    setError(null);
    setResult(null);
    setProgress(`Reading ${selectedFile.name}...`);
    try {
      const fileBytes = new Uint8Array(await selectedFile.arrayBuffer());
      const key = randomBytes(32);
      const iv = randomBytes(12);

      const meta: ProofyInnerMeta = {
        name: selectedFile.name,
        type: selectedFile.type || "application/octet-stream",
        size: selectedFile.size,
        createdAt: new Date().toISOString(),
      };

      setStorageState("encrypting");
      setProgress("Encrypting locally...");
      const inner = encodeInner(meta, fileBytes);
      const ciphertext = await aesGcmEncrypt(key, iv, inner);
      const header = buildHeader(iv);
      const blob = encodeBlob(header, ciphertext);

      if (blob.length > MAX_FILE_SIZE) {
        throw new Error(
          `Encrypted blob is ${formatBytes(BigInt(blob.length))}, above the ${formatBytes(BigInt(MAX_FILE_SIZE))} transaction limit.`,
        );
      }
      if (allowance && allowance.remainingBytes < BigInt(blob.length)) {
        throw new Error(
          `Remaining allowance is ${formatBytes(allowance.remainingBytes)}, but this encrypted blob needs ${formatBytes(BigInt(blob.length))}. Create a storage account again to top up.`,
        );
      }

      setStorageState("storing");
      const store = await storeBlob(
        blob,
        selectedAccount.polkadotSigner,
        setProgress,
      );

      const recovery = buildRecovery({
        cid: store.cid,
        key32: key,
        blobSize: blob.length,
        blockNumber: store.blockNumber,
        extrinsicIndex: store.extrinsicIndex,
      });

      setResult({
        store,
        recovery,
        fileBaseName: safeBaseName(selectedFile.name),
        authorAddress: selectedAddress,
      });
      setStorageState("done");
      setProgress("Uploaded. Download recovery now.");
      setAllowance(await fetchAllowance(selectedAddress));
    } catch (e) {
      setStorageState("failed");
      setProgress(null);
      if (e instanceof BulletinError) {
        setError(`${e.message} - ${e.recoveryHint}`);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  }, [
    allowance,
    canUpload,
    selectedAccount,
    selectedAddress,
    selectedFile,
  ]);

  return (
    <main className="shell">
      <Nav />
      <header className="masthead masthead-network">
        <div
          className={`net-chip ${chain.status === "error" ? "net-error" : ""}`}
        >
          {chain.status === "connecting" && "connecting to Bulletin..."}
          {chain.status === "ready" && chain.name}
          {chain.status === "error" && "Bulletin RPC unreachable"}
        </div>
      </header>

      <h1 className="app-title">
        Encrypt locally. Upload to decentralized storage. Download recovery.
      </h1>

      <section className="rail" aria-label="Connection status">
        <div className="rail-row">
          <span className={`dot ${walletConnected ? "on" : ""}`} />
          <span className="rail-key">Wallet</span>
          <span className="rail-val">
            {walletConnected ? (
              <>
                Connected
                {selectedAccount?.name && (
                  <span className="wallet-account-name">
                    {selectedAccount.name}
                  </span>
                )}
                <code
                  className="wallet-address"
                  title={selectedAddress ?? undefined}
                >
                  {selectedAddress}
                </code>
              </>
            ) : (
              "Not connected"
            )}
          </span>
        </div>
        <div className="rail-row">
          <span
            className={`dot ${authorized ? "on" : ""} ${
              checkingAllowance ? "checking" : ""
            }`}
          />
          <span className="rail-key">Bulletin</span>
          <span className="rail-val">
            {!walletConnected && "Waiting for a wallet"}
            {walletConnected && checkingAllowance && "Checking authorization..."}
            {walletConnected &&
              !checkingAllowance &&
              (authorized
                ? "Authorized"
                : allowance?.expired
                  ? "Not authorized - allowance expired"
                  : "Not authorized")}
          </span>
        </div>
      </section>

      <section
        className="voucher"
        aria-label="Storage allowance"
        data-authorized={authorized}
      >
        <div className="punch" aria-hidden />
        <div className={`stamp ${authorized ? "inked" : "hollow"}`}>
          {authorized ? "Authorized" : "Not authorized"}
        </div>
        <div className="voucher-eyebrow">
          Storage allowance - {BULLETIN_NETWORK_NAME}
        </div>
        <div className={`voucher-account ${selectedAddress ? "" : "empty"}`}>
          {selectedAddress ?? "no account connected"}
        </div>
        <div className="meters">
          <div className="meter">
            <span
              className={`meter-num ${allowance && !allowance.expired ? "" : "faded"}`}
            >
              {allowance ? formatNumber(allowance.remainingTransactions) : "-"}
            </span>
            <span className="meter-label">transactions left</span>
          </div>
          <div className="meter">
            <span
              className={`meter-num ${allowance && !allowance.expired ? "" : "faded"}`}
            >
              {allowance ? formatBytes(allowance.remainingBytes) : "-"}
            </span>
            <span className="meter-label">storage left</span>
          </div>
        </div>
        <div className="voucher-foot">
          {allowance?.expiresAtBlock != null
            ? allowance.expired
              ? `expired at block #${formatNumber(allowance.expiresAtBlock)} - request a new allowance`
              : `valid until block #${formatNumber(allowance.expiresAtBlock)}`
            : "no active authorization on this account"}
        </div>
      </section>

      <section className="actions">
        {!walletConnected && (
          <div className="actions-row">
            <button
              className="btn btn-ink"
              onClick={connectWallet}
              disabled={connectingHostWallet}
            >
              {connectingHostWallet ? "Connecting..." : "Connect wallet"}
            </button>
          </div>
        )}

        {walletConnected && (
          <>
            {accounts.length > 1 && (
              <select
                className="account-select"
                aria-label="Account"
                value={selectedAddress ?? ""}
                onChange={(event) => setSelectedAddress(event.target.value)}
              >
                {accounts.map((account) => (
                  <option key={account.address} value={account.address}>
                    {account.name
                      ? `${account.name} - ${shortAddress(account.address)}`
                      : account.address}
                  </option>
                ))}
              </select>
            )}
            <div className="actions-row">
              <button
                className="btn btn-pink"
                onClick={createStorageAccount}
                disabled={
                  busy || chain.status === "error" || !canCreateStorageAccount
                }
              >
                {busy && storageState === "idle"
                  ? "Working..."
                  : "Create storage account"}
              </button>
              <span className="btn-sub">
                Grants {GRANT_TRANSACTIONS} transactions -{" "}
                {formatBytes(GRANT_BYTES)}
                {authorized
                  ? " - adds to the existing allowance"
                  : allowance?.expired
                    ? " - replaces the expired allowance"
                    : ""}
              </span>
            </div>

            <div
              className="file-drop"
              onDragOver={(event) => event.preventDefault()}
              onDrop={dropFile}
            >
              <input
                id="file-upload"
                className="file-input"
                type="file"
                onChange={(event) =>
                  selectFile(event.target.files?.[0] ?? null)
                }
                disabled={!authorized || busy}
              />
              <label
                className={`file-drop-label ${!authorized || busy ? "disabled" : ""}`}
                htmlFor="file-upload"
              >
                <span>{selectedFile ? selectedFile.name : "Drop a file"}</span>
                <small>
                  {selectedFile && estimatedBlobSize != null
                    ? `${formatBytes(BigInt(selectedFile.size))} file - about ${formatBytes(BigInt(estimatedBlobSize))} blob`
                    : "Choose a file to encrypt locally"}
                </small>
              </label>
            </div>

            {fileTooLarge && estimatedBlobSize != null && (
              <p className="error">
                This encrypted blob is about{" "}
                {formatBytes(BigInt(estimatedBlobSize))}. The single-transaction
                limit is{" "}
                {formatBytes(BigInt(MAX_FILE_SIZE))}.
              </p>
            )}
            {allowanceTooSmall && estimatedBlobSize != null && allowance && (
              <p className="error">
                Remaining allowance is {formatBytes(allowance.remainingBytes)}.
                This encrypted blob needs about{" "}
                {formatBytes(BigInt(estimatedBlobSize))}. Create a storage
                account again to top up.
              </p>
            )}

            <div className="actions-row">
              <button
                className="btn btn-pink"
                onClick={uploadFile}
                disabled={!canUpload}
              >
                {busy && storageState !== "idle" ? "Uploading..." : "Upload file"}
              </button>
              <span className="btn-sub">
                Encrypting - Storing - Finalized
              </span>
            </div>
          </>
        )}

        {progress && (
          <p className="progress" role="status">
            {progress}
          </p>
        )}
        {storageState !== "idle" && (
          <div className="steps" aria-label="Storage upload progress">
            {["encrypting", "storing", "done"].map(
              (step) => (
                <span
                  key={step}
                  className={
                    step === storageState ||
                    storageState === "done" ||
                    (step === "encrypting" && storageState === "storing")
                      ? "step active"
                      : "step"
                  }
                >
                  {step}
                </span>
              ),
            )}
          </div>
        )}
        {error && <p className="error">{error}</p>}
        {allowanceError && <p className="error">{allowanceError}</p>}
      </section>

      {result && (
        <section className="voucher result-card" aria-label="Uploaded file">
          <div className="punch" aria-hidden />
          <div className="stamp inked">Finalized</div>
          <div className="voucher-eyebrow">SoverStore storage upload</div>
          <div className="result-grid">
            <span>CID</span>
            <code>{result.store.cid}</code>
            <span>Block</span>
            <code>
              {result.store.blockNumber != null
                ? `#${formatNumber(result.store.blockNumber)}`
                : "recorded"}
            </code>
            <span>Author</span>
            <code title={result.authorAddress}>
              {shortAddress(result.authorAddress)}
            </code>
          </div>
          <div className="actions-row result-actions">
            <button
              className="btn btn-ink"
              onClick={() =>
                downloadRecovery(result.fileBaseName, result.recovery)
              }
            >
              Download recovery.json
            </button>
            <button
              className="btn btn-ghost"
              onClick={() =>
                void downloadRecoveryQrCard(
                  result.fileBaseName,
                  result.recovery,
                ).catch((e) =>
                  setError(e instanceof Error ? e.message : String(e)),
                )
              }
            >
              Download QR card
            </button>
          </div>
          <p className="warning qr-warning">
            This QR opens the recovery app and previews the document
            automatically. Keep it private: anyone with the QR can recover the
            file.
          </p>
          <p className="warning">
            The recovery file is the only way to open the original. SoverStore
            does not keep a copy of the key. Anyone holding CID + recovery can
            read the document.
          </p>
        </section>
      )}

      <footer className="foot">
        Note: Renewal is not yet implemented in SoverStore. The current
        retention period is 201,600 blocks; retention extension will be added
        in a future version.
      </footer>
    </main>
  );
}

export default function Home() {
  const [hasRecoveryLink, setHasRecoveryLink] = useState(false);

  useEffect(() => {
    const detectRecoveryLink = () => {
      const params = new URLSearchParams(window.location.hash.slice(1));
      if (params.has("recovery")) setHasRecoveryLink(true);
    };

    detectRecoveryLink();
    window.addEventListener("hashchange", detectRecoveryLink);
    return () => window.removeEventListener("hashchange", detectRecoveryLink);
  }, []);

  return hasRecoveryLink ? <PreviewPage /> : <StorageHome />;
}
