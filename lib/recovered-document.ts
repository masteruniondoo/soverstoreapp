import type { ProofyInnerMeta } from "@/lib/blob/format";

export type RecoveredDocument = {
  meta: ProofyInnerMeta;
  content: Uint8Array;
  objectUrl: string;
};

export type DocumentPreviewKind = "image" | "pdf" | "text" | "unavailable";

const MAX_TEXT_PREVIEW_BYTES = 512 * 1024;

const RISKY_EXTENSIONS = new Set([
  "bat",
  "cmd",
  "com",
  "exe",
  "hta",
  "htm",
  "html",
  "jar",
  "js",
  "msi",
  "ps1",
  "scr",
  "svg",
  "vbs",
]);

function safeDownloadName(meta: ProofyInnerMeta): string {
  const trimmed = meta.name.trim();
  return (trimmed || "recovered-document").replace(/[\\/:*?"<>|]+/g, "-");
}

export function createDocumentUrl(
  meta: ProofyInnerMeta,
  content: Uint8Array,
): string {
  const bytes = new Uint8Array(content.length);
  bytes.set(content);
  const blob = new Blob([bytes.buffer as ArrayBuffer], {
    type: meta.type || "application/octet-stream",
  });
  return URL.createObjectURL(blob);
}

function recoveredFile(result: RecoveredDocument): File {
  const bytes = new Uint8Array(result.content.length);
  bytes.set(result.content);
  return new File([bytes.buffer as ArrayBuffer], safeDownloadName(result.meta), {
    type: result.meta.type || "application/octet-stream",
  });
}

function recoveredBlob(result: RecoveredDocument): Blob {
  const bytes = new Uint8Array(result.content.length);
  bytes.set(result.content);
  return new Blob([bytes.buffer as ArrayBuffer], {
    type: result.meta.type || "application/octet-stream",
  });
}

function legacyCopyText(text: string): boolean {
  const input = document.createElement("textarea");
  input.value = text;
  input.readOnly = true;
  input.style.position = "fixed";
  input.style.inset = "0 auto auto -10000px";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.focus();
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  return copied;
}

async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Embedded mobile WebViews may expose the API while denying the call. The
    // selection-based fallback still works in a number of those hosts.
  }
  if (!legacyCopyText(text)) {
    throw new Error(
      "The mobile app did not allow clipboard access. Select the text in the preview and copy it manually.",
    );
  }
}

async function imageAsPng(result: RecoveredDocument): Promise<Blob> {
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("The recovered image could not be prepared for copying."));
    image.src = result.objectUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This mobile browser cannot copy images.");
  context.drawImage(image, 0, 0);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("The recovered image could not be copied.")),
      "image/png",
    );
  });
}

export type CopiedDocumentKind = "text" | "image" | "file";

/**
 * Copies the decrypted content rather than its temporary blob URL. Text uses
 * the broadly-supported text clipboard path. Images are normalized to PNG,
 * which is the binary clipboard format supported by mobile Chromium/WebKit.
 * Other file types are offered only when the browser explicitly supports their
 * MIME type; copying a blob URL would be useless outside this page.
 */
export async function copyDocument(
  result: RecoveredDocument,
): Promise<CopiedDocumentKind> {
  const type = result.meta.type.toLowerCase().split(";", 1)[0].trim();
  if (type.startsWith("text/") || type === "application/json") {
    await copyText(new TextDecoder("utf-8", { fatal: false }).decode(result.content));
    return "text";
  }

  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error(
      type.startsWith("image/")
        ? "The mobile app does not expose image clipboard access. Long-press the preview to copy or save the image."
        : "This file type cannot be copied by the mobile clipboard. Open SoverStore on desktop to save the recovered file.",
    );
  }

  let clipboardContent: Blob | Promise<Blob> = recoveredBlob(result);
  let clipboardType = type || "application/octet-stream";
  let copiedKind: CopiedDocumentKind = "file";
  if (type.startsWith("image/")) {
    copiedKind = "image";
    if (clipboardType !== "image/png" || !ClipboardItem.supports(clipboardType)) {
      clipboardType = "image/png";
      clipboardContent = imageAsPng(result);
    }
  }
  if (!ClipboardItem.supports(clipboardType)) {
    throw new Error(
      "This file type cannot be copied by the mobile clipboard. Open SoverStore on desktop to save the recovered file.",
    );
  }

  try {
    await navigator.clipboard.write([
      // Passing the conversion promise lets write() start during the original
      // click gesture; awaiting image conversion first makes mobile WebViews
      // revoke clipboard access before the actual write begins.
      new ClipboardItem({ [clipboardType]: clipboardContent }),
    ]);
  } catch (error) {
    const reason = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(
      `The mobile app did not allow this document to be copied.${reason}`,
    );
  }
  return copiedKind;
}

export async function downloadDocument(
  result: RecoveredDocument,
): Promise<void> {
  const file = recoveredFile(result);
  const shareNavigator = navigator as Navigator & {
    canShare?: (data: ShareData) => boolean;
  };
  let shareFailure: string | null = null;

  if (
    typeof navigator.share === "function" &&
    shareNavigator.canShare?.({ files: [file] })
  ) {
    try {
      // File-only payload is the most interoperable shape on iOS WebKit.
      await navigator.share({ files: [file] });
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      shareFailure = error instanceof Error ? error.message : String(error);
      // A cross-origin sandbox may deny Web Share. Try the Product host next.
    }
  }

  const { isInsideContainer, navigateTo } = await import(
    "@parity/product-sdk-host"
  );
  if (await isInsideContainer()) {
    const navigation = await navigateTo(result.objectUrl);
    if (navigation.ok) return;
    throw new Error(
      `The Polkadot web gateway blocked file export from its sandbox.${shareFailure ? ` Web Share: ${shareFailure}.` : ""} Host navigation: ${navigation.error.message}`,
    );
  }

  const anchor = document.createElement("a");
  anchor.href = result.objectUrl;
  anchor.download = safeDownloadName(result.meta);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function hasBytes(content: Uint8Array, expected: number[], offset = 0): boolean {
  return expected.every((value, index) => content[offset + index] === value);
}

export function documentPreviewKind(
  result: RecoveredDocument,
): DocumentPreviewKind {
  const { content, meta } = result;
  const type = meta.type.toLowerCase().split(";", 1)[0].trim();
  const extension = meta.name.split(".").pop()?.toLowerCase() ?? "";

  if (RISKY_EXTENSIONS.has(extension)) return "unavailable";
  if (type.startsWith("text/") && content.length <= MAX_TEXT_PREVIEW_BYTES) {
    return "text";
  }
  if (type === "application/json" && content.length <= MAX_TEXT_PREVIEW_BYTES) {
    return "text";
  }
  if (
    type === "application/pdf" &&
    hasBytes(content, [0x25, 0x50, 0x44, 0x46, 0x2d])
  ) {
    return "pdf";
  }
  if (
    type === "image/png" &&
    hasBytes(content, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ) {
    return "image";
  }
  if (type === "image/jpeg" && hasBytes(content, [0xff, 0xd8, 0xff])) {
    return "image";
  }
  if (
    type === "image/gif" &&
    (hasBytes(content, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
      hasBytes(content, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))
  ) {
    return "image";
  }
  if (
    type === "image/webp" &&
    hasBytes(content, [0x52, 0x49, 0x46, 0x46]) &&
    hasBytes(content, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "image";
  }
  return "unavailable";
}
