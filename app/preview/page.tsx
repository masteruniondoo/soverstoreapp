"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseRecovery } from "@/lib/artifacts/recovery";
import { decodeBlob, decodeInner } from "@/lib/blob/format";
import { fetchBlobByCid } from "@/lib/bulletin/retrieve";
import { aesGcmDecrypt } from "@/lib/crypto/aes";
import { base64ToBytes } from "@/lib/crypto/hash";
import {
  createDocumentUrl,
  documentPreviewKind,
  downloadDocument,
  type RecoveredDocument,
} from "@/lib/recovered-document";

type PreviewStatus = "loading" | "ready" | "error";

const INVALID_DOCUMENT_MESSAGE =
  "This document does not exist or the QR code is invalid.";

export default function PreviewPage() {
  const [status, setStatus] = useState<PreviewStatus>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [result, setResult] = useState<RecoveredDocument | null>(null);
  const resultUrlRef = useRef<string | null>(null);
  const recoveryTextRef = useRef<string | null>(null);
  const recoveryAttemptRef = useRef(0);
  const recoveryLinkHandledRef = useRef(false);
  const mountedRef = useRef(true);

  const clearResult = useCallback(() => {
    if (resultUrlRef.current) {
      URL.revokeObjectURL(resultUrlRef.current);
      resultUrlRef.current = null;
    }
    setResult(null);
  }, []);

  const recoverFromText = useCallback(
    async (text: string) => {
      const attempt = recoveryAttemptRef.current + 1;
      recoveryAttemptRef.current = attempt;
      clearResult();
      recoveryTextRef.current = text;
      setErrorMessage(null);
      setDiagnostics([]);
      setStatus("loading");

      try {
        const recovery = parseRecovery(text);
        const storedBlob = await fetchBlobByCid(recovery.cid, {
          blockNumber: recovery.chain?.blockNumber,
          extrinsicIndex: recovery.chain?.extrinsicIndex,
          size: recovery.blobSize,
          onDiagnostic: (message) => {
            if (mountedRef.current) {
              setDiagnostics((current) => [...current, message]);
            }
          },
        });
        if (
          !mountedRef.current ||
          recoveryAttemptRef.current !== attempt
        ) {
          return;
        }

        const decoded = decodeBlob(storedBlob);
        const plain = await aesGcmDecrypt(
          base64ToBytes(recovery.key),
          base64ToBytes(decoded.header.iv),
          decoded.ciphertext,
        );
        if (
          !mountedRef.current ||
          recoveryAttemptRef.current !== attempt
        ) {
          return;
        }

        const inner = decodeInner(plain);
        const objectUrl = createDocumentUrl(inner.meta, inner.content);
        resultUrlRef.current = objectUrl;
        setResult({
          meta: inner.meta,
          content: inner.content,
          objectUrl,
        });
        setStatus("ready");
      } catch (error) {
        if (mountedRef.current && recoveryAttemptRef.current === attempt) {
          clearResult();
          setErrorMessage(
            error instanceof Error ? error.message : String(error),
          );
          setStatus("error");
        }
      }
    },
    [clearResult],
  );

  useEffect(() => {
    const loadRecoveryFromHash = () => {
      const params = new URLSearchParams(window.location.hash.slice(1));
      const linkedRecovery = params.get("recovery");

      if (!linkedRecovery) {
        if (recoveryLinkHandledRef.current) return;
        recoveryAttemptRef.current += 1;
        clearResult();
        setErrorMessage("The recovery data is missing from the URL.");
        setStatus("error");
        return;
      }

      recoveryLinkHandledRef.current = true;
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
      void recoverFromText(linkedRecovery);
    };

    loadRecoveryFromHash();
    window.addEventListener("hashchange", loadRecoveryFromHash);
    return () => window.removeEventListener("hashchange", loadRecoveryFromHash);
  }, [clearResult, recoverFromText]);

  useEffect(
    () => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        if (resultUrlRef.current) {
          URL.revokeObjectURL(resultUrlRef.current);
        }
      };
    },
    [],
  );

  if (status === "loading") {
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

  if (status === "error" || !result) {
    return (
      <main className="qr-preview-message" role="alert">
        <p>{INVALID_DOCUMENT_MESSAGE}</p>
        {errorMessage && <p className="preview-error-detail">{errorMessage}</p>}
        {diagnostics.length > 0 && (
          <pre className="preview-diagnostics">{diagnostics.join("\n")}</pre>
        )}
        {recoveryTextRef.current && (
          <button
            className="btn btn-pink"
            type="button"
            onClick={() => void recoverFromText(recoveryTextRef.current!)}
          >
            Retry recovery
          </button>
        )}
      </main>
    );
  }

  const kind = documentPreviewKind(result);
  const textPreview =
    kind === "text"
      ? new TextDecoder("utf-8", { fatal: false }).decode(result.content)
      : null;

  return (
    <main className="qr-preview-page">
      <section className="qr-document-preview" aria-label="Document preview">
        {kind === "image" && (
          // Blob URLs keep the decrypted file local to this browser.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={result.objectUrl} alt={`Preview of ${result.meta.name}`} />
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
            This file type cannot be previewed safely.
          </p>
        )}
        <button
          className="btn btn-pink"
          type="button"
          onClick={() => {
            setDownloadError(null);
            void downloadDocument(result).catch((error) =>
              setDownloadError(
                error instanceof Error ? error.message : String(error),
              ),
            );
          }}
        >
          Save / share document
        </button>
        {downloadError && (
          <p className="preview-error-detail">{downloadError}</p>
        )}
      </section>
    </main>
  );
}
