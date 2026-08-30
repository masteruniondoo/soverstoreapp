"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Nav } from "@/components/Nav";
import { parseRecovery } from "@/lib/artifacts/recovery";
import {
  decodeRecoveryQrImage,
  downloadRecoveryQrCard,
} from "@/lib/artifacts/recovery-qr";
import { decodeBlob, decodeInner } from "@/lib/blob/format";
import { fetchBlobByCid } from "@/lib/bulletin/retrieve";
import { aesGcmDecrypt } from "@/lib/crypto/aes";
import { base64ToBytes } from "@/lib/crypto/hash";
import { formatBytes } from "@/lib/format";
import {
  copyDocument,
  createDocumentUrl,
  documentPreviewKind,
  downloadDocument,
  type RecoveredDocument,
} from "@/lib/recovered-document";

export default function RecoveryPage() {
  const [recoveryFile, setRecoveryFile] = useState<File | null>(null);
  const [qrFile, setQrFile] = useState<File | null>(null);
  const [recoveryText, setRecoveryText] = useState("");
  const [busy, setBusy] = useState(false);
  const [linkedRecoveryBusy, setLinkedRecoveryBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [result, setResult] = useState<RecoveredDocument | null>(null);
  const resultUrlRef = useRef<string | null>(null);
  const recoveryAttemptRef = useRef(0);

  const clearResult = useCallback(() => {
    if (resultUrlRef.current) {
      URL.revokeObjectURL(resultUrlRef.current);
      resultUrlRef.current = null;
    }
    setResult(null);
  }, []);

  const cancelRecovery = useCallback(() => {
    recoveryAttemptRef.current += 1;
    setBusy(false);
    setLinkedRecoveryBusy(false);
    clearResult();
  }, [clearResult]);

  useEffect(
    () => () => {
      if (resultUrlRef.current) {
        URL.revokeObjectURL(resultUrlRef.current);
      }
      recoveryAttemptRef.current += 1;
    },
    [],
  );

  const canRecover = useMemo(
    () => !busy && recoveryText.trim().length > 0,
    [busy, recoveryText],
  );

  const loadRecovery = useCallback(async (file: File | null) => {
    setRecoveryFile(file);
    setQrFile(null);
    cancelRecovery();
    setError(null);
    setProgress(null);
    if (file) {
      const text = await file.text();
      try {
        parseRecovery(text);
        setRecoveryText(text);
      } catch (e) {
        setRecoveryText("");
        setError(e instanceof Error ? e.message : String(e));
      }
    } else {
      setRecoveryText("");
    }
  }, [cancelRecovery]);

  const loadQrRecovery = useCallback(async (file: File | null) => {
    setQrFile(file);
    setRecoveryFile(null);
    cancelRecovery();
    setError(null);
    setRecoveryText("");
    if (!file) return;

    setProgress("Reading QR recovery image...");
    try {
      setRecoveryText(await decodeRecoveryQrImage(file));
      setProgress("QR recovery data loaded and validated.");
    } catch (e) {
      setProgress(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [cancelRecovery]);

  const recoverFromText = useCallback(
    async (text: string, fromLinkedQr = false) => {
      if (!text.trim()) return;

      const attempt = recoveryAttemptRef.current + 1;
      recoveryAttemptRef.current = attempt;
      setBusy(true);
      setLinkedRecoveryBusy(fromLinkedQr);
      setError(null);
      setDiagnostics([]);
      clearResult();
      setProgress("Reading recovery file...");

      try {
        const recovery = parseRecovery(text);

        setProgress("Downloading encrypted blob from Bulletin...");
        const storedBlob = await fetchBlobByCid(recovery.cid, {
          blockNumber: recovery.chain?.blockNumber,
          extrinsicIndex: recovery.chain?.extrinsicIndex,
          size: recovery.blobSize,
          onDiagnostic: (message) => {
            if (recoveryAttemptRef.current === attempt) {
              setDiagnostics((current) => [...current, message]);
            }
          },
        });
        if (recoveryAttemptRef.current !== attempt) return;
        const decoded = decodeBlob(storedBlob);

        setProgress("Decrypting document locally...");
        const plain = await aesGcmDecrypt(
          base64ToBytes(recovery.key),
          base64ToBytes(decoded.header.iv),
          decoded.ciphertext,
        );
        if (recoveryAttemptRef.current !== attempt) return;
        const inner = decodeInner(plain);

        const objectUrl = createDocumentUrl(inner.meta, inner.content);
        resultUrlRef.current = objectUrl;
        setResult({
          meta: inner.meta,
          content: inner.content,
          objectUrl,
        });
        setProgress(
          "Document recovered. Review the preview before downloading.",
        );
      } catch (e) {
        if (recoveryAttemptRef.current === attempt) {
          setProgress(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (recoveryAttemptRef.current === attempt) {
          setBusy(false);
          setLinkedRecoveryBusy(false);
        }
      }
    },
    [clearResult],
  );

  const recover = useCallback(() => {
    void recoverFromText(recoveryText);
  }, [recoverFromText, recoveryText]);

  useEffect(() => {
    const loadRecoveryFromHash = () => {
      if (!window.location.hash) return;

      const params = new URLSearchParams(window.location.hash.slice(1));
      const linkedRecovery = params.get("recovery");
      if (!linkedRecovery) return;

      setRecoveryText(linkedRecovery);
      setRecoveryFile(null);
      setQrFile(null);
      setError(null);

      // Remove the recovery key from the visible URL and browser history before
      // retrieving the encrypted file. URL fragments are not sent to the host.
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
      void recoverFromText(linkedRecovery, true);
    };

    loadRecoveryFromHash();
    window.addEventListener("hashchange", loadRecoveryFromHash);
    return () => window.removeEventListener("hashchange", loadRecoveryFromHash);
  }, [recoverFromText]);

  const kind = result ? documentPreviewKind(result) : "unavailable";
  const textPreview =
    result && kind === "text"
      ? new TextDecoder("utf-8", { fatal: false }).decode(result.content)
      : null;

  if (linkedRecoveryBusy) {
    return (
      <main
        className="recovery-loading-screen"
        aria-busy="true"
        aria-live="polite"
      >
        <div className="recovery-loading-spinner" aria-hidden="true" />
        <p>Recovery in progress...</p>
        {diagnostics.length > 0 && (
          <pre className="preview-diagnostics">{diagnostics.join("\n")}</pre>
        )}
      </main>
    );
  }

  return (
    <main className="shell drops-page">
      <Nav />
      <h1 className="app-title">Recover a document from saved recovery data.</h1>

      <section className="actions">
        <h2 className="input-heading">Upload recovery.json</h2>
        <div className="file-drop">
          <input
            id="recovery-upload"
            className="file-input"
            type="file"
            accept="application/json,.json"
            onChange={(event) => loadRecovery(event.target.files?.[0] ?? null)}
          />
          <label className="file-drop-label" htmlFor="recovery-upload">
            <span>
              {recoveryFile ? recoveryFile.name : "Drop the recovery file"}
            </span>
            <small>Use the private .recovery.json artifact.</small>
          </label>
        </div>

        <div className="input-divider">
          <span>or</span>
        </div>
        <h2 className="input-heading">Import QR image</h2>
        <div className="file-drop">
          <input
            id="qr-recovery-upload"
            className="file-input"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/*"
            onChange={(event) =>
              void loadQrRecovery(event.target.files?.[0] ?? null)
            }
          />
          <label className="file-drop-label" htmlFor="qr-recovery-upload">
            <span>
              {qrFile ? qrFile.name : "Choose a QR image or screenshot"}
            </span>
            <small>The QR must contain valid SoverStore recovery data.</small>
          </label>
        </div>

        <div className="input-divider">
          <span>or</span>
        </div>
        <h2 className="input-heading">Paste recovery data</h2>
        <textarea
          className="json-input"
          aria-label="Recovery JSON"
          placeholder='{"format":"proofbox/recovery@1","cid":"...","key":"..."}'
          value={recoveryText}
          onChange={(event) => {
            setRecoveryText(event.target.value);
            setRecoveryFile(null);
            setQrFile(null);
            cancelRecovery();
            setError(null);
            setProgress(null);
          }}
        />

        <button
          className="btn btn-pink"
          onClick={recover}
          disabled={!canRecover}
        >
          {busy ? "Recovering..." : "Recover & preview"}
        </button>

        {progress && (
          <p className="progress" role="status">
            {progress}
          </p>
        )}
        {error && <p className="error">{error}</p>}
        {diagnostics.length > 0 && (
          <pre className="preview-diagnostics">{diagnostics.join("\n")}</pre>
        )}
      </section>

      <section className="voucher result-card" aria-label="Recovery result">
        <div className="punch" aria-hidden />
        <div className={`stamp ${result ? "inked" : "hollow"}`}>
          {result ? "Recovered" : "Recovery"}
        </div>
        <div className="voucher-eyebrow">Document recovery</div>
        {result ? (
          <div className="result-grid">
            <span>Name</span>
            <code>{result.meta.name}</code>
            <span>Type</span>
            <code>{result.meta.type || "application/octet-stream"}</code>
            <span>Size</span>
            <code>{formatBytes(BigInt(result.content.length))}</code>
          </div>
        ) : (
          <p className="result-summary">
            Load recovery data to decrypt and preview the original document.
          </p>
        )}
        {result && (
          <div className="recovery-preview">
            <h2 className="preview-heading">Safe preview</h2>
            {kind === "image" && (
              // Blob URLs keep the decrypted file local to this browser.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={result.objectUrl}
                alt={`Preview of ${result.meta.name}`}
              />
            )}
            {kind === "pdf" && (
              <iframe
                src={result.objectUrl}
                title={`Preview of ${result.meta.name}`}
                sandbox=""
              />
            )}
            {kind === "text" && <pre>{textPreview}</pre>}
            {kind === "unavailable" && (
              <p className="preview-unavailable">
                This file type cannot be previewed safely. Check its name, type,
                and size carefully before choosing to download it.
              </p>
            )}
            <button
              className="btn btn-pink preview-download"
              type="button"
              onClick={() => {
                setError(null);
                void copyDocument(result)
                  .then((copiedKind) => {
                    setProgress(
                      copiedKind === "image"
                        ? "Image copied. Paste it into a message, email, notes, or another app."
                        : copiedKind === "text"
                          ? "Document text copied to the clipboard."
                          : "Document copied to the clipboard.",
                    );
                  })
                  .catch((e) =>
                    setError(e instanceof Error ? e.message : String(e)),
                  );
              }}
            >
              Copy recovered document
            </button>
            <button
              className="btn btn-ghost preview-download desktop-file-action"
              type="button"
              onClick={() => {
                setError(null);
                void downloadDocument(result).catch((e) =>
                  setError(e instanceof Error ? e.message : String(e)),
                );
              }}
            >
              Save / share recovered file
            </button>
            <button
              className="btn btn-ghost preview-download desktop-file-action"
              type="button"
              onClick={() => {
                void downloadRecoveryQrCard(
                  result.meta.name.replace(/\.[^/.]+$/, "") || "recovery",
                  parseRecovery(recoveryText),
                ).catch((e) =>
                  setError(e instanceof Error ? e.message : String(e)),
                );
              }}
            >
              Download browser recovery QR
            </button>
            <p className="preview-safety-note">
              Preview does not guarantee that a file is malware-free. Download
              and open it only if you trust its source.
            </p>
          </div>
        )}
        <p className="warning">
          Recovery data contains the CID and decryption key. Keep JSON and QR
          copies private.
        </p>
      </section>
    </main>
  );
}
