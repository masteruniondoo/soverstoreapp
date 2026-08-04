"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BulletinError, MAX_FILE_SIZE } from "@parity/bulletin-sdk";
import { useAppSession } from "@/components/AppSessionProvider";
import { Nav } from "@/components/Nav";
import PreviewPage from "@/app/preview/page";
import {
  estimateStoreAuthorization,
  ensureAccountBulletinReady,
  storeBlob,
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
import { BULLETIN_NETWORK_NAME } from "@/lib/runtime-config";
import {
  isBulletinTransportTimeout,
  recoverTimedOutBulletinTransport,
} from "@/lib/bulletin/recovery";

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

function safeBaseName(name: string): string {
  const trimmed = name.trim().replace(/\.[^/.]+$/, "");
  return (trimmed || "proofbox-file").replace(/[\\/:*?"<>|]+/g, "-");
}

function StorageHome() {
  const {
    accounts,
    selectedAccount,
    selectedAddress,
    walletStatus,
    connectWallet: connectSessionWallet,
    selectAccount,
    bulletinAllowance: allowance,
    checkingBulletinAllowance: checkingAllowance,
    bulletinAllowanceError: allowanceError,
    refreshBulletinAllowance: refreshAllowance,
    setKnownBulletinAllowance,
  } = useAppSession();

  const [busy, setBusy] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [storageState, setStorageState] = useState<StorageState>("idle");
  const [result, setResult] = useState<StorageResult | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const walletConnected = selectedAddress != null;
  const authorizationResolved = allowance !== undefined;
  const authorized = allowance?.usable === true;
  const estimatedBlobSize = useMemo(
    () => (selectedFile ? estimateBlobSize(selectedFile) : null),
    [selectedFile],
  );
  const fileTooLarge =
    estimatedBlobSize != null && estimatedBlobSize > MAX_FILE_SIZE;
  const estimatedAuthorization =
    estimatedBlobSize == null
      ? null
      : estimateStoreAuthorization(estimatedBlobSize);
  const allowanceTooSmall =
    estimatedBlobSize != null &&
    estimatedAuthorization != null &&
    allowance != null &&
    allowance.usable &&
    (allowance.remainingBytes < estimatedAuthorization.bytes ||
      allowance.remainingTransactions < estimatedAuthorization.transactions);
  const canRequestAllowance =
    walletConnected &&
    authorizationResolved &&
    !checkingAllowance &&
    (!authorized || allowanceTooSmall);
  const canUpload =
    selectedFile != null &&
    selectedAccount != null &&
    authorized &&
    !busy &&
    !fileTooLarge &&
    !allowanceTooSmall;

  useEffect(() => {
    if (!busy && !authorized && storageState === "idle") {
      setProgress(null);
    }
  }, [authorized, busy, storageState]);

  const connectWallet = useCallback(async () => {
    setError(null);
    setBusy(true);
    setProgress("Connecting wallet...");
    let connectedAddress: string | null = null;
    try {
      const account = await connectSessionWallet();
      connectedAddress = account.address;
      const next = await ensureAccountBulletinReady(
        account.address,
        setProgress,
      );
      setKnownBulletinAllowance(account.address, next);
      setProgress(
        `Bulletin ready: ${formatNumber(next.remainingTransactions)} transaction(s), ${formatBytes(next.remainingBytes)} remaining.`,
      );
    } catch (e) {
      if (
        connectedAddress &&
        recoverTimedOutBulletinTransport(connectedAddress, e)
      ) {
        return;
      }
      setProgress(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [connectSessionWallet, setKnownBulletinAllowance]);

  const createStorageAccount = useCallback(async () => {
    if (!selectedAddress || busy || !canRequestAllowance) return;
    setBusy(true);
    setError(null);
    setProgress("Requesting host-managed Bulletin allowance...");
    try {
      const next = await ensureAccountBulletinReady(
        selectedAddress,
        setProgress,
        estimatedAuthorization ?? undefined,
      );
      setKnownBulletinAllowance(selectedAddress, next);
      setProgress(
        `Bulletin ready: ${formatNumber(next.remainingTransactions)} transaction(s), ${formatBytes(next.remainingBytes)} remaining.`,
      );
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
  }, [selectedAddress, busy, canRequestAllowance, estimatedAuthorization, setKnownBulletinAllowance]);

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
    setProgress("Refreshing Bulletin allowance...");
    try {
      const currentAllowance = await refreshAllowance(true, true, true);
      const estimatedRequired = estimateStoreAuthorization(
        estimateBlobSize(selectedFile),
      );
      if (!currentAllowance?.usable) {
        throw new Error(
          "Bulletin allowance is missing, expired, or exhausted. Request a new allowance before uploading.",
        );
      }
      if (
        currentAllowance.remainingBytes < estimatedRequired.bytes ||
        currentAllowance.remainingTransactions < estimatedRequired.transactions
      ) {
        throw new Error(
          "The current Bulletin allowance is too small for this upload. Request a new allowance.",
        );
      }

      setProgress(`Reading ${selectedFile.name}...`);
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
      const exactRequired = estimateStoreAuthorization(blob.length);
      if (
        currentAllowance.remainingBytes < exactRequired.bytes ||
        currentAllowance.remainingTransactions < exactRequired.transactions
      ) {
        throw new Error(
          `Remaining allowance is ${formatBytes(currentAllowance.remainingBytes)} and ${formatNumber(currentAllowance.remainingTransactions)} transaction(s), but this Bulletin upload needs ${formatBytes(exactRequired.bytes)} and ${formatNumber(exactRequired.transactions)} transaction(s). Request a new Bulletin allowance.`,
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
      void refreshAllowance(false).catch(() => undefined);
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
    canUpload,
    selectedAccount,
    selectedAddress,
    selectedFile,
    refreshAllowance,
  ]);

  return (
    <main className="shell">
      <Nav />
      <header className="masthead masthead-network">
        <div className="net-chip">{BULLETIN_NETWORK_NAME}</div>
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
            {walletConnected &&
              (checkingAllowance || !authorizationResolved) &&
              "Checking authorization..."}
            {walletConnected &&
              !checkingAllowance &&
              authorizationResolved &&
              (authorized
                ? "Authorized"
                : allowance?.expired
                  ? "Not authorized - allowance expired"
                  : allowance?.exhausted
                    ? "Not authorized - allowance exhausted"
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
          {!authorizationResolved || checkingAllowance
            ? "Checking..."
            : authorized
              ? "Authorized"
              : "Not authorized"}
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
              className={`meter-num ${allowance?.usable ? "" : "faded"}`}
            >
              {allowance ? formatNumber(allowance.remainingTransactions) : "-"}
            </span>
            <span className="meter-label">transactions left</span>
          </div>
          <div className="meter">
            <span
              className={`meter-num ${allowance?.usable ? "" : "faded"}`}
            >
              {allowance ? formatBytes(allowance.remainingBytes) : "-"}
            </span>
            <span className="meter-label">storage left</span>
          </div>
        </div>
        <div className="voucher-foot">
          {!authorizationResolved || checkingAllowance
            ? "looking up this account on Bulletin"
            : allowance?.expiresAtBlock != null
            ? allowance.expired
              ? `expired at block #${formatNumber(allowance.expiresAtBlock)} - request a new allowance`
              : allowance.exhausted
                ? "allowance quota exhausted - request a new allowance"
                : `valid until block #${formatNumber(allowance.expiresAtBlock)}${allowance.remainingBlocks == null ? "" : ` (${formatNumber(allowance.remainingBlocks)} blocks left)`}`
            : "no active authorization on this account"}
        </div>
      </section>

      <section className="actions">
        {!walletConnected && (
          <div className="actions-row">
            <button
              className="btn btn-ink"
              onClick={connectWallet}
              disabled={walletStatus === "connecting" || busy}
            >
              {walletStatus === "connecting" || busy ? "Connecting..." : "Connect wallet"}
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
                onChange={(event) => selectAccount(event.target.value)}
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
                disabled={busy || !canRequestAllowance}
              >
                {!authorizationResolved || checkingAllowance
                  ? "Checking Bulletin..."
                  : busy && storageState === "idle"
                  ? "Working..."
                  : "Request Bulletin allowance"}
              </button>
              <span className="btn-sub">
                Host-managed Devnet quota. Available when missing, expired,
                exhausted, or too small for the selected file.
              </span>
              {allowanceError && (
                <button
                  className="btn btn-ink"
                  type="button"
                  disabled={checkingAllowance}
                  onClick={() => void refreshAllowance(true).catch(() => undefined)}
                >
                  Retry Bulletin check
                </button>
              )}
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
                This Bulletin upload needs about{" "}
                {estimatedAuthorization
                  ? formatBytes(estimatedAuthorization.bytes)
                  : "-"} and{" "}
                {estimatedAuthorization?.transactions.toString() ?? "-"} transaction(s).
                Request a new Bulletin allowance.
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
        {error && (
          <p className="error">
            {error}
            {isBulletinTransportTimeout(error) && (
              <>
                {" "}
                <button
                  className="btn btn-ink"
                  type="button"
                  onClick={() => window.location.reload()}
                >
                  Reload page
                </button>
              </>
            )}
          </p>
        )}
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
