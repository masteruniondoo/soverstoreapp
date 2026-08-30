"use client";

/**
 * Saves/shares a `File` as reliably as the current host allows.
 * `<a download>` alone is unreliable on iOS WebKit -- it often just
 * navigates to or opens the blob instead of prompting a save -- and is
 * inert entirely inside the Polkadot web gateway's sandboxed iframe. Try,
 * in priority order:
 *
 * 1. Web Share (file payload) -- the most interoperable path on iOS.
 * 2. The Product host's `navigateTo()`, for the sandboxed gateway iframe.
 * 3. A plain `<a download>` click, for ordinary desktop browsers.
 */
export async function saveFile(file: File): Promise<void> {
  const shareNavigator = navigator as Navigator & {
    canShare?: (data: ShareData) => boolean;
  };
  let shareFailure: string | null = null;

  if (
    typeof navigator.share === "function" &&
    shareNavigator.canShare?.({ files: [file] })
  ) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      shareFailure = error instanceof Error ? error.message : String(error);
      // A cross-origin sandbox may deny Web Share. Try the Product host next.
    }
  }

  const objectUrl = URL.createObjectURL(file);
  const { isInsideContainer, navigateTo } = await import(
    "@parity/product-sdk-host"
  );
  if (await isInsideContainer()) {
    const navigation = await navigateTo(objectUrl);
    if (navigation.ok) return;
    throw new Error(
      `The Polkadot web gateway blocked file export from its sandbox.${shareFailure ? ` Web Share: ${shareFailure}.` : ""} Host navigation: ${navigation.error.message}`,
    );
  }

  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = file.name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}
