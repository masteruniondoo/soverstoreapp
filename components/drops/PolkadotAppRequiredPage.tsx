"use client";

import { useState } from "react";

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
  if (!copied) {
    throw new Error("Clipboard access is not available. Copy the link shown below.");
  }
}

export function PolkadotAppRequiredPage({ dropLink }: { dropLink: string }) {
  const [copyStatus, setCopyStatus] = useState<string | null>(null);

  return (
    <main className="shell app-required-page">
      <span className="story-kicker">Polkadot App only</span>
      <h1>Open this Drop inside Polkadot</h1>
      <p>
        SoverStore does not open Drops in a web browser. Use the app-only link
        below in Polkadot Desktop or the Polkadot mobile app.
      </p>
      <ol className="app-required-steps">
        <li>Copy the Drop link.</li>
        <li>Open Polkadot Desktop or the Polkadot mobile app.</li>
        <li>Open Browse, paste the link, and confirm.</li>
        <li>The app should open this Drop directly.</li>
      </ol>
      <div className="app-required-actions">
        <button
          className="btn btn-pink"
          type="button"
          onClick={() => {
            setCopyStatus(null);
            void copyText(dropLink).then(
              () => setCopyStatus("App-only Drop link copied. Paste it into Polkadot Browse."),
              (error) => setCopyStatus(error instanceof Error ? error.message : String(error)),
            );
          }}
        >
          Copy Drop link
        </button>
      </div>
      <code className="app-required-url">{dropLink}</code>
      {copyStatus && <p role="status">{copyStatus}</p>}
      <p className="app-required-hint">
        This link is intentionally not a Chrome or Safari URL.
      </p>
    </main>
  );
}
