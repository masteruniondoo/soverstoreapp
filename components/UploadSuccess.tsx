"use client";

import { useEffect, useState } from "react";
import { copyImage, copyText } from "@/lib/clipboard";
import {
  formatRecoveryText,
  recoveryUrl,
  type RecoveryDetails,
} from "@/lib/artifacts/recovery";
import {
  downloadRecoveryQrCard,
  recoveryQrDataUrl,
  recoveryQrPngBlob,
} from "@/lib/artifacts/recovery-qr";
import { formatNumber, shortAddress } from "@/lib/format";
import { detectSoverStoreRuntime } from "@/lib/runtime/soverstore-runtime";

type CopyState = "idle" | "copied" | "fallback" | "failed";

/**
 * Everything the user leaves this upload with.
 *
 * The CID is public and recoverable from the chain; the Recovery Key exists
 * only here, in this tab, until it is copied or photographed. So it is shown
 * in full rather than masked, and the two copy actions are the primary
 * buttons on the card - a user who closes this page without using one of them
 * cannot open the file again.
 *
 * A download cannot be relied on to carry it out: the gateway sandboxes this
 * app with `allow-scripts allow-same-origin allow-forms allow-pointer-lock`
 * and no `allow-downloads`, so a page-initiated save is blocked outright
 * (Polkadot-Community-Foundation/products-devnet-issues#14). Copying and the
 * on-screen QR work everywhere.
 */
export function UploadSuccess({
  recovery,
  fileBaseName,
  authorAddress,
  blockNumber,
}: {
  recovery: RecoveryDetails;
  fileBaseName: string;
  authorAddress: string;
  blockNumber?: number;
}) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recoveryCopy, setRecoveryCopy] = useState<CopyState>("idle");
  const [qrCopy, setQrCopy] = useState<CopyState>("idle");
  const [downloadsBlocked, setDownloadsBlocked] = useState(false);

  const recoveryText = formatRecoveryText(recovery);

  useEffect(() => {
    let cancelled = false;
    void recoveryQrDataUrl(recovery).then(
      (url) => {
        if (!cancelled) setQrDataUrl(url);
      },
      (nextError: unknown) => {
        if (!cancelled) {
          setQrError(
            nextError instanceof Error ? nextError.message : String(nextError),
          );
        }
      },
    );
    void detectSoverStoreRuntime().then((runtime) => {
      if (!cancelled) setDownloadsBlocked(runtime === "web-gateway");
    });
    return () => {
      cancelled = true;
    };
  }, [recovery]);

  // Long enough to read, short enough that the button is ready for a retry.
  const settle = (setState: (state: CopyState) => void, state: CopyState) => {
    setState(state);
    setTimeout(() => setState("idle"), 4_000);
  };

  const copyRecovery = async () => {
    setError(null);
    settle(setRecoveryCopy, (await copyText(recoveryText)) ? "copied" : "failed");
  };

  /**
   * The picture if the browser will take it, otherwise the link the picture
   * encodes - the same credential in the form that always copies.
   */
  const copyQrCode = async () => {
    setError(null);
    try {
      if (await copyImage(await recoveryQrPngBlob(recovery))) {
        settle(setQrCopy, "copied");
        return;
      }
      settle(
        setQrCopy,
        (await copyText(recoveryUrl(recovery))) ? "fallback" : "failed",
      );
    } catch (nextError) {
      setQrCopy("failed");
      setError(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
    }
  };

  const label = (state: CopyState, idle: string): string =>
    state === "copied"
      ? "Copied"
      : state === "fallback"
        ? "Link copied"
        : state === "failed"
          ? "Select it below"
          : idle;

  return (
    <section className="voucher result-card" aria-label="Upload successful">
      <div className="punch" aria-hidden />
      <div className="stamp inked">Finalized</div>
      <div className="voucher-eyebrow">Upload successful</div>

      <div className="result-grid">
        <span>Bulletin CID</span>
        <code>{recovery.cid}</code>
        <span>Recovery Key</span>
        <code className="recovery-key-value">{recovery.key}</code>
        <span>Block</span>
        <code>
          {blockNumber != null ? `#${formatNumber(blockNumber)}` : "recorded"}
        </code>
        <span>Author</span>
        <code title={authorAddress}>{shortAddress(authorAddress)}</code>
      </div>

      <div className="actions-row result-actions">
        <button
          className="btn btn-pink"
          type="button"
          onClick={() => void copyRecovery()}
        >
          {label(recoveryCopy, "Copy Recovery")}
        </button>
        <button
          className="btn btn-ink"
          type="button"
          onClick={() => void copyQrCode()}
        >
          {label(qrCopy, "Copy QR Code")}
        </button>
        <button
          className="btn btn-ghost desktop-file-action"
          type="button"
          onClick={() =>
            void downloadRecoveryQrCard(fileBaseName, recovery).catch((e) =>
              setError(e instanceof Error ? e.message : String(e)),
            )
          }
        >
          Save QR image
        </button>
      </div>

      {qrDataUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className="recovery-qr-image"
          src={qrDataUrl}
          alt="Recovery QR code"
          width={256}
          height={256}
        />
      )}
      {qrError && (
        <p className="error">The QR code could not be drawn: {qrError}</p>
      )}
      {error && <p className="error">{error}</p>}

      <textarea
        className="recovery-text"
        readOnly
        rows={3}
        value={recoveryText}
        onFocus={(event) => event.currentTarget.select()}
        aria-label="Recovery information"
      />

      {downloadsBlocked && (
        <p className="warning">
          Downloads are blocked inside the Polkadot web gateway, so Save QR
          image may do nothing here. Use Copy Recovery, or photograph the QR
          code, before you leave this page.
        </p>
      )}

      <p className="warning">
        <strong>Save your recovery information.</strong> SoverStore does not
        store your Recovery Key. You need either the CID and Recovery Key, or
        the recovery QR code, to recover this file later. Anyone who has them
        can recover it too.
      </p>
    </section>
  );
}
