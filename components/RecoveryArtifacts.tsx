"use client";

import { useEffect, useState } from "react";
import { copyText } from "@/lib/clipboard";
import { recoveryLink, recoveryQrDataUrl } from "@/lib/artifacts/recovery-qr";
import type { RecoveryV1 } from "@/lib/artifacts/recovery";
import { detectSoverStoreRuntime } from "@/lib/runtime/soverstore-runtime";

type CopyState = "idle" | "copied" | "failed";

/**
 * The recovery document, on screen and copyable.
 *
 * A download cannot be relied on here. The gateway sandboxes this app with
 * `allow-scripts allow-same-origin allow-forms allow-pointer-lock` and no
 * `allow-downloads`, so a page-initiated save is blocked outright, and the
 * host's own `navigateTo` fallback reports success while opening nothing
 * (Polkadot-Community-Foundation/products-devnet-issues#14). Nothing inside
 * the app can lift a restriction set by the parent frame.
 *
 * So the recovery is shown instead: the QR as an image the viewer can save or
 * photograph, and the text to copy. The copy buttons work everywhere, not just
 * where downloads fail, because copying is often what a user wanted anyway.
 */
export function RecoveryArtifacts({ recovery }: { recovery: RecoveryV1 }) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [jsonCopy, setJsonCopy] = useState<CopyState>("idle");
  const [linkCopy, setLinkCopy] = useState<CopyState>("idle");
  const [downloadsBlocked, setDownloadsBlocked] = useState(false);

  const recoveryJson = JSON.stringify(recovery, null, 2);

  useEffect(() => {
    let cancelled = false;
    void recoveryQrDataUrl(recovery).then(
      (url) => {
        if (!cancelled) setQrDataUrl(url);
      },
      (error: unknown) => {
        if (!cancelled) {
          setQrError(error instanceof Error ? error.message : String(error));
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

  const copy = async (
    value: string,
    setState: (state: CopyState) => void,
  ): Promise<void> => {
    const copied = await copyText(value);
    setState(copied ? "copied" : "failed");
    // Long enough to read, short enough that the button is ready for a retry.
    setTimeout(() => setState("idle"), 4_000);
    if (!copied) setRevealed(true);
  };

  const label = (state: CopyState, idle: string): string =>
    state === "copied" ? "Copied" : state === "failed" ? "Select it below" : idle;

  return (
    <div className="recovery-artifacts">
      {downloadsBlocked && (
        <p className="warning">
          Downloads are blocked inside the Polkadot web gateway, so the buttons
          above may do nothing here. Copy the recovery below, or save the QR
          image, before you leave this page.
        </p>
      )}

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
      {qrError && <p className="error">The QR code could not be drawn: {qrError}</p>}

      <div className="actions-row">
        <button
          className="btn btn-ink"
          type="button"
          onClick={() => void copy(recoveryJson, setJsonCopy)}
        >
          {label(jsonCopy, "Copy recovery JSON")}
        </button>
        <button
          className="btn btn-ghost"
          type="button"
          onClick={() => void copy(recoveryLink(recovery), setLinkCopy)}
        >
          {label(linkCopy, "Copy recovery link")}
        </button>
        <button
          className="btn btn-ghost"
          type="button"
          onClick={() => setRevealed((shown) => !shown)}
        >
          {revealed ? "Hide recovery text" : "Show recovery text"}
        </button>
      </div>

      {revealed && (
        <textarea
          className="recovery-text"
          readOnly
          rows={10}
          value={recoveryJson}
          onFocus={(event) => event.currentTarget.select()}
          aria-label="Recovery document"
        />
      )}
    </div>
  );
}
