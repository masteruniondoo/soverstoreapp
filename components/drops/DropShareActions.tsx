"use client";

import { useState } from "react";
import { copyText } from "@/lib/clipboard";
import { getDropAppLink } from "@/lib/drops/share-links";

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
