"use client";

/**
 * Copying text from inside the Polkadot web gateway's sandboxed iframe.
 *
 * `navigator.clipboard` is the modern path, but the gateway serves this app
 * cross-origin and sets no `allow="clipboard-write"`, so Permissions Policy
 * can deny it there while it works everywhere else. The deprecated
 * `execCommand("copy")` is not governed by that policy and still succeeds in
 * exactly the place the modern API does not, which is why it is kept as a
 * fallback rather than removed.
 *
 * Returns whether the text reached the clipboard, so a caller can tell the
 * user to select it manually instead of claiming a copy that never happened.
 *
 * Both paths are injectable so the choice between them can be tested with no
 * clipboard and no DOM present.
 */
export type ClipboardPaths = {
  /** The modern API, or null where the browser exposes none. */
  writeText: ((text: string) => Promise<void>) | null;
  /** The selection-based fallback; returns whether the copy took. */
  legacyCopy: (text: string) => boolean;
};

function browserPaths(): ClipboardPaths {
  const clipboard =
    typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  return {
    writeText: clipboard?.writeText
      ? (text: string) => clipboard.writeText(text)
      : null,
    legacyCopy: copyViaSelection,
  };
}

export async function copyText(
  text: string,
  paths: ClipboardPaths = browserPaths(),
): Promise<boolean> {
  if (paths.writeText) {
    try {
      await paths.writeText(text);
      return true;
    } catch {
      // Denied by Permissions Policy, or no transient activation. Fall through.
    }
  }

  return paths.legacyCopy(text);
}

function copyViaSelection(text: string): boolean {
  if (typeof document === "undefined") return false;

  const carrier = document.createElement("textarea");
  carrier.value = text;
  // Kept in the layout but out of sight: a display:none element cannot be
  // selected, and selection is what execCommand copies.
  carrier.setAttribute("readonly", "");
  carrier.style.position = "fixed";
  carrier.style.top = "0";
  carrier.style.left = "0";
  carrier.style.opacity = "0";
  document.body.appendChild(carrier);

  try {
    carrier.select();
    carrier.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    carrier.remove();
  }
}

/**
 * Copying an image, for `Copy QR Code`.
 *
 * `ClipboardItem` is the only way to put a picture on the clipboard, and it
 * is missing or blocked in more places than `writeText` is: older browsers
 * expose no constructor at all, and the gateway's sandbox can deny the write
 * even where it exists. There is no `execCommand` equivalent to fall back on,
 * so this reports failure instead and the caller copies the recovery link
 * text - which is exactly what the QR encodes anyway.
 */
export type ImageClipboardPaths = {
  /** The async clipboard write, or null where the browser exposes none. */
  write: ((items: unknown[]) => Promise<void>) | null;
  /** Wraps a blob in a `ClipboardItem`, or null where there is no constructor. */
  createItem: ((type: string, blob: Blob) => unknown) | null;
};

function browserImagePaths(): ImageClipboardPaths {
  const clipboard =
    typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  const hasItem =
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { ClipboardItem?: unknown }).ClipboardItem ===
      "function";
  return {
    write: clipboard?.write
      ? (items) => clipboard.write(items as ClipboardItem[])
      : null,
    createItem: hasItem
      ? (type, blob) => new ClipboardItem({ [type]: blob })
      : null,
  };
}

export async function copyImage(
  blob: Blob,
  paths: ImageClipboardPaths = browserImagePaths(),
): Promise<boolean> {
  if (!paths.write || !paths.createItem) return false;
  try {
    await paths.write([paths.createItem(blob.type || "image/png", blob)]);
    return true;
  } catch {
    // No image clipboard support here, or the write was denied.
    return false;
  }
}
