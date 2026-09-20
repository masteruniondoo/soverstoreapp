"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Nav } from "@/components/Nav";
import { RecoveryQrScanner } from "@/components/RecoveryQrScanner";
import {
  normalizeRecoveryDetails,
  type RecoveryDetails,
} from "@/lib/artifacts/recovery";
import { parseRecoveryInput } from "@/lib/artifacts/recovery-input";
import { parseLegacyRecoveryLink } from "@/lib/artifacts/recovery-legacy";
import {
  decodeRecoveryQrImage,
  downloadRecoveryQrCard,
} from "@/lib/artifacts/recovery-qr";
import { formatBytes } from "@/lib/format";
import { recoverFile } from "@/lib/recovery/recover-file";
import {
  copyDocument,
  createDocumentUrl,
  documentPreviewKind,
  downloadDocument,
  type RecoveredDocument,
} from "@/lib/recovered-document";

export default function RecoveryPage() {
  const [cid, setCid] = useState("");
  const [key, setKey] = useState("");
  const [pasted, setPasted] = useState("");
  const [qrFile, setQrFile] = useState<File | null>(null);
  const [scanning, setScanning] = useState(false);
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

  /**
   * The one recovery path. A recovery link, a scan, an imported QR, a pasted
   * Copy Recovery block and the two fields below all arrive here as a CID and
   * a Recovery Key; nothing decrypts anywhere else, so no entry method can
   * end up on a cryptographic path of its own.
   */
  const startRecovery = useCallback(
    async (details: RecoveryDetails, fromLink = false) => {
      const attempt = recoveryAttemptRef.current + 1;
      recoveryAttemptRef.current = attempt;
      const isCurrent = () => recoveryAttemptRef.current === attempt;

      setBusy(true);
      setLinkedRecoveryBusy(fromLink);
      setError(null);
      setDiagnostics([]);
      clearResult();

      try {
        const recovered = await recoverFile(details.cid, details.key, {
          onProgress: (message) => {
            if (isCurrent()) setProgress(message);
          },
          onDiagnostic: (message) => {
            if (isCurrent()) setDiagnostics((current) => [...current, message]);
          },
        });
        if (!isCurrent()) return;

        const objectUrl = createDocumentUrl(recovered.meta, recovered.content);
        resultUrlRef.current = objectUrl;
        setResult({ ...recovered, objectUrl });
        setProgress("File recovered. Review the preview before downloading.");
      } catch (e) {
        if (!isCurrent()) return;
        setProgress(null);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (isCurrent()) {
          setBusy(false);
          setLinkedRecoveryBusy(false);
        }
      }
    },
    [clearResult],
  );

  /** Fills both fields from one scanned, imported, or linked code. */
  const applyDetails = useCallback(
    (details: RecoveryDetails, fromLink = false) => {
      setCid(details.cid);
      setKey(details.key);
      setError(null);
      void startRecovery(details, fromLink);
    },
    [startRecovery],
  );

  const recover = useCallback(() => {
    try {
      const details = normalizeRecoveryDetails({ cid, key });
      setCid(details.cid);
      setKey(details.key);
      void startRecovery(details);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [cid, key, startRecovery]);

  /**
   * Anything pasted whole: the two lines Copy Recovery writes, a recovery
   * link, or a recovery document from before the Recovery Key change. It only
   * fills the fields; the user still presses Recover File.
   */
  const readPasted = useCallback((value: string) => {
    setPasted(value);
    setError(null);
    setProgress(null);
    if (!value.trim()) return;
    try {
      const details = parseRecoveryInput(value);
      setCid(details.cid);
      setKey(details.key);
      setProgress("CID and Recovery Key read from the pasted text.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadQrRecovery = useCallback(
    async (file: File | null) => {
      setQrFile(file);
      cancelRecovery();
      setError(null);
      if (!file) return;

      setProgress("Reading the recovery QR image...");
      try {
        applyDetails(await decodeRecoveryQrImage(file));
      } catch (e) {
        setProgress(null);
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [applyDetails, cancelRecovery],
  );

  const handleScannedQr = useCallback(
    (details: RecoveryDetails) => {
      setScanning(false);
      setQrFile(null);
      cancelRecovery();
      applyDetails(details);
    },
    [applyDetails, cancelRecovery],
  );

  useEffect(() => {
    const loadRecoveryFromUrl = () => {
      const url = new URL(window.location.href);
      const linkedKey = new URLSearchParams(url.hash.replace(/^#/, "")).get(
        "key",
      );

      let details: RecoveryDetails | null = null;
      try {
        details = linkedKey
          ? normalizeRecoveryDetails({
              cid: url.searchParams.get("cid") ?? "",
              key: linkedKey,
            })
          : parseLegacyRecoveryLink(url);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
      if (!details) return;

      // Take the Recovery Key out of the visible URL and out of browser
      // history before anything is fetched. The fragment never reached a
      // server; this keeps it from being read off the address bar either.
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
      applyDetails(details, true);
    };

    loadRecoveryFromUrl();
    window.addEventListener("hashchange", loadRecoveryFromUrl);
    return () => window.removeEventListener("hashchange", loadRecoveryFromUrl);
  }, [applyDetails]);

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
      <h1 className="app-title">
        Recover a file with its Bulletin CID and Recovery Key.
      </h1>

      <section className="actions">
        <h2 className="input-heading">Enter recovery information</h2>
        <div className="recover-form">
          <label>
            Bulletin CID
            <input
              type="text"
              value={cid}
              spellCheck={false}
              autoComplete="off"
              placeholder="bafk..."
              onChange={(event) => {
                setCid(event.target.value);
                cancelRecovery();
                setError(null);
              }}
            />
          </label>
          <label>
            Recovery Key
            <input
              type="text"
              value={key}
              spellCheck={false}
              autoComplete="off"
              placeholder="the 256-bit key from the upload screen"
              onChange={(event) => {
                setKey(event.target.value);
                cancelRecovery();
                setError(null);
              }}
            />
          </label>
        </div>
        <button
          className="btn btn-pink"
          type="button"
          onClick={recover}
          disabled={busy || !cid.trim() || !key.trim()}
        >
          {busy ? "Recovering..." : "Recover File"}
        </button>

        <div className="input-divider">
          <span>or</span>
        </div>
        <h2 className="input-heading">Paste copied recovery</h2>
        <textarea
          className="json-input"
          aria-label="Copied recovery information"
          placeholder={"CID: bafk...\nRecovery Key: ..."}
          value={pasted}
          onChange={(event) => readPasted(event.target.value)}
        />

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
            <small>The QR must be a SoverStore recovery code.</small>
          </label>
        </div>

        <div className="input-divider">
          <span>or</span>
        </div>
        <h2 className="input-heading">Scan with camera</h2>
        {scanning ? (
          <RecoveryQrScanner
            onDecoded={handleScannedQr}
            onClose={() => setScanning(false)}
          />
        ) : (
          <>
            <button
              className="btn btn-ink"
              type="button"
              onClick={() => setScanning(true)}
            >
              Scan QR code
            </button>
            <small>
              Camera access currently only works inside the mobile app.
              Desktop and browser tabs cannot reach the camera yet — use
              &quot;Import QR image&quot; there instead.
            </small>
          </>
        )}

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
        <div className="voucher-eyebrow">File recovery</div>
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
            Bulletin holds the encrypted file, and anyone may download it. The
            Recovery Key is the only thing that opens it, and it never leaves
            this browser.
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
                setError(null);
                try {
                  void downloadRecoveryQrCard(
                    result.meta.name.replace(/\.[^/.]+$/, "") || "recovery",
                    normalizeRecoveryDetails({ cid, key }),
                  ).catch((e) =>
                    setError(e instanceof Error ? e.message : String(e)),
                  );
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              Save recovery QR
            </button>
            <p className="preview-safety-note">
              Preview does not guarantee that a file is malware-free. Download
              and open it only if you trust its source.
            </p>
          </div>
        )}
        <p className="warning">
          A Recovery Key, and any QR code carrying one, opens the file for
          whoever holds it. Keep both private.
        </p>
      </section>
    </main>
  );
}
