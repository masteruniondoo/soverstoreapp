"use client";

import { useState } from "react";
import { parseDropEntryValue } from "@/lib/drops/drop-route";
import { openDropInCurrentApp } from "@/lib/drops/in-app-navigation";
import { DROP_SHARE_ORIGIN } from "@/lib/runtime-config";

export function OpenDropLinkForm({ compact = false }: { compact?: boolean }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className={`open-drop-link${compact ? " is-compact" : ""}`}
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = parseDropEntryValue(value, DROP_SHARE_ORIGIN);
        if (parsed.kind !== "drop") {
          setError("Paste a valid SoverStore Browse link or enter its numeric ID.");
          return;
        }
        setError(null);
        openDropInCurrentApp(parsed.dropId);
      }}
    >
      <div>
        <strong>Open a shared Drop</strong>
        <span>Paste a new or legacy Browse link, or enter the Drop ID.</span>
      </div>
      <div className="open-drop-link-controls">
        <input
          type="text"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="soverstore.dot/drop/7 or 7"
          aria-label="Drop link or ID"
        />
        <button className="btn btn-pink" type="submit">Open Drop</button>
      </div>
      {error && <p className="drops-open-error" role="alert">{error}</p>}
    </form>
  );
}
