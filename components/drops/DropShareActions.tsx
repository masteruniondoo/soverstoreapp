"use client";

import { useState } from "react";
import { getDropAppLink } from "@/lib/drops/share-links";

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("The Drop link could not be copied.");
}

export function DropShareActions({
  dropId,
  compact = false,
}: {
  dropId: string;
  compact?: boolean;
}) {
  const [status, setStatus] = useState<string | null>(null);
  const dropLink = getDropAppLink(dropId);

  const copy = async () => {
    await copyText(dropLink);
    setStatus("App-only link copied. Paste it into Polkadot Browse.");
  };

  return (
    <div className={`drop-share-actions${compact ? " is-compact" : ""}`}>
      {!compact && <code>{dropLink}</code>}
      <div className="actions-row">
        <button className="btn btn-ink" type="button" onClick={() => void copy().catch((error) => setStatus(String(error)))}>
          Copy link
        </button>
      </div>
      {status && <small role="status">{status}</small>}
    </div>
  );
}
