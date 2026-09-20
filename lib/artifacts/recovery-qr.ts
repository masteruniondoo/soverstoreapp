"use client";

import jsQR from "jsqr";
import QRCode from "qrcode";
import {
  isRecoveryRoutePath,
  parseRecoveryUrl,
  recoveryAppOrigin,
  recoveryUrl,
  type RecoveryDetails,
} from "@/lib/artifacts/recovery";
import { parseLegacyRecoveryLink } from "@/lib/artifacts/recovery-legacy";
import { saveFile } from "@/lib/files/save-file";

const QR_SIZE = 1024;

const QR_OPTIONS = {
  width: QR_SIZE,
  margin: 4,
  errorCorrectionLevel: "Q",
  color: { dark: "#000000", light: "#ffffff" },
} as const;

/**
 * What the QR encodes: the recovery link, CID in the query and Recovery Key
 * in the fragment. A recovery QR is therefore a bearer credential - whoever
 * photographs it can open the file.
 */
export function recoveryQrPayload(recovery: RecoveryDetails): string {
  return recoveryUrl(recovery);
}

/** The QR as a data URL, for showing it on the page. */
export async function recoveryQrDataUrl(
  recovery: RecoveryDetails,
): Promise<string> {
  return QRCode.toDataURL(recoveryQrPayload(recovery), { ...QR_OPTIONS });
}

/** The same QR as a PNG blob, for the clipboard or a download. */
export async function recoveryQrPngBlob(
  recovery: RecoveryDetails,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  await QRCode.toCanvas(canvas, recoveryQrPayload(recovery), { ...QR_OPTIONS });
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) =>
        value ? resolve(value) : reject(new Error("Could not create QR code.")),
      "image/png",
    ),
  );
}

export async function downloadRecoveryQrCard(
  fileName: string,
  recovery: RecoveryDetails,
): Promise<void> {
  const blob = await recoveryQrPngBlob(recovery);
  await saveFile(
    new File([blob], `${fileName}.recovery-qr.png`, { type: "image/png" }),
  );
}

function trustedRecoveryOrigins(): Set<string> {
  const origins = new Set([recoveryAppOrigin()]);
  if (typeof window !== "undefined") origins.add(window.location.origin);
  return origins;
}

/**
 * Validates raw QR text and returns the CID and Recovery Key it carries.
 * Shared by the static-image and live-camera decode paths, so a scanned code
 * and an imported screenshot cannot disagree about what a recovery QR is.
 */
function extractRecoveryFromQrText(data: string): RecoveryDetails {
  const trimmed = data.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error("This QR code does not contain a SoverStore recovery link.");
  }

  const url = new URL(trimmed);
  if (
    !trustedRecoveryOrigins().has(url.origin) ||
    !isRecoveryRoutePath(url.pathname)
  ) {
    throw new Error("This QR code does not contain a SoverStore recovery link.");
  }

  // QR cards printed before the Recovery Key change carried the whole
  // recovery document in the fragment instead of a `key=` parameter.
  const legacy = parseLegacyRecoveryLink(url);
  return legacy ?? parseRecoveryUrl(trimmed);
}

export async function decodeRecoveryQrImage(
  file: File,
): Promise<RecoveryDetails> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Choose a PNG, JPEG, or other image containing a QR code.");
  }

  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("This browser cannot read the QR image.");
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const decoded = jsQR(image.data, image.width, image.height, {
      inversionAttempts: "attemptBoth",
    });
    if (!decoded?.data) {
      throw new Error("No readable QR code was found in this image.");
    }
    return extractRecoveryFromQrText(decoded.data);
  } finally {
    bitmap.close();
  }
}

/**
 * Tries to decode one live-camera frame. Returns `null` (never throws) when
 * the frame has no QR code, or has one that isn't a valid SoverStore
 * recovery code -- a live scanner should keep scanning past unrelated QR
 * codes it happens to see, not stop on them.
 */
export function tryDecodeRecoveryQrFrame(
  image: ImageData,
): RecoveryDetails | null {
  const decoded = jsQR(image.data, image.width, image.height, {
    inversionAttempts: "dontInvert",
  });
  if (!decoded?.data) return null;
  try {
    return extractRecoveryFromQrText(decoded.data);
  } catch {
    return null;
  }
}
