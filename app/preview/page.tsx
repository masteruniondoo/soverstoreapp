"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  normalizeRecoveryDetails,
  type RecoveryDetails,
} from "@/lib/artifacts/recovery";
import { parseLegacyRecoveryLink } from "@/lib/artifacts/recovery-legacy";
import { recoverFile } from "@/lib/recovery/recover-file";
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
  // Held only to power Retry. It is never rendered and never logged.
  const recoveryRef = useRef<RecoveryDetails | null>(null);
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

  const startRecovery = useCallback(
    async (details: RecoveryDetails) => {
      const attempt = recoveryAttemptRef.current + 1;
      recoveryAttemptRef.current = attempt;
      const isCurrent = () =>
        mountedRef.current && recoveryAttemptRef.current === attempt;

      clearResult();
      recoveryRef.current = details;
      setErrorMessage(null);
      setDiagnostics([]);
      setStatus("loading");

      try {
        const recovered = await recoverFile(details.cid, details.key, {
          onDiagnostic: (message) => {
            if (mountedRef.current) {
              setDiagnostics((current) => [...current, message]);
            }
          },
        });
        if (!isCurrent()) return;

        const objectUrl = createDocumentUrl(recovered.meta, recovered.content);
        resultUrlRef.current = objectUrl;
        setResult({ ...recovered, objectUrl });
        setStatus("ready");
      } catch (error) {
        if (!isCurrent()) return;
        clearResult();
        setErrorMessage(error instanceof Error ? error.message : String(error));
        setStatus("error");
      }
    },
    [clearResult],
  );

  useEffect(() => {
    const loadRecoveryFromUrl = () => {
      const url = new URL(window.location.href);
      const linkedKey = new URLSearchParams(url.hash.replace(/^#/, "")).get(
        "key",
      );

      let details: RecoveryDetails | null = null;
      let failure: string | null = null;
      try {
        details = linkedKey
          ? normalizeRecoveryDetails({
              cid: url.searchParams.get("cid") ?? "",
              key: linkedKey,
            })
          : parseLegacyRecoveryLink(url);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }

      if (!details) {
        if (recoveryLinkHandledRef.current && !failure) return;
        recoveryAttemptRef.current += 1;
        clearResult();
        setErrorMessage(
          failure ?? "The Recovery Key is missing from the link.",
        );
        setStatus("error");
        return;
      }

      recoveryLinkHandledRef.current = true;
      // The key travelled in the fragment, so it never reached a server. Drop
      // it from the address bar and from history before anything is fetched.
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
      void startRecovery(details);
    };

    loadRecoveryFromUrl();
    window.addEventListener("hashchange", loadRecoveryFromUrl);
    return () => window.removeEventListener("hashchange", loadRecoveryFromUrl);
  }, [clearResult, startRecovery]);

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
        {recoveryRef.current && (
          <button
            className="btn btn-pink"
            type="button"
            onClick={() => void startRecovery(recoveryRef.current!)}
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
