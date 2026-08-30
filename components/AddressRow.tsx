"use client";

import { useState } from "react";
import { copyText } from "@/lib/clipboard";

export function AddressRow({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await copyText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard permission denied or unsupported; the address text is
      // still fully visible and selectable.
    }
  };

  return (
    <div className="address-row">
      <code className="address-value">{address}</code>
      <button
        className="btn btn-ink btn-sm"
        type="button"
        onClick={() => void copy()}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
