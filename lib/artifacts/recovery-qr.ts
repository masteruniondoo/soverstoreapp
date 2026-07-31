"use client";

import jsQR from "jsqr";
import QRCode from "qrcode";
import { parseRecovery, type RecoveryV1 } from "@/lib/artifacts/recovery";
import { APP_ORIGIN } from "@/lib/runtime-config";

const QR_SIZE = 1024;

function recoveryAppOrigin(): string {
  if (APP_ORIGIN) return APP_ORIGIN.replace(/\/$/, "");
  if (typeof window !== "undefined") return window.location.origin;
  throw new Error("The Devnet application origin is not configured.");
}

function trustedRecoveryOrigins(): Set<string> {
  const origins = new Set([recoveryAppOrigin()]);
  if (typeof window !== "undefined") origins.add(window.location.origin);
  return origins;
}

export async function downloadRecoveryQrCard(
  fileName: string,
  recovery: RecoveryV1,
): Promise<void> {
  const canvas = document.createElement("canvas");
  const encodedRecovery = encodeURIComponent(JSON.stringify(recovery));
  const recoveryUrl =
    `${recoveryAppOrigin()}/recovery/?chainBackend=rpc-gateway` +
    `#recovery=${encodedRecovery}`;

  await QRCode.toCanvas(canvas, recoveryUrl, {
    width: QR_SIZE,
    margin: 4,
    errorCorrectionLevel: "Q",
    color: { dark: "#000000", light: "#ffffff" },
  });

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) =>
        value
          ? resolve(value)
          : reject(new Error("Could not create QR code.")),
      "image/png",
    ),
  );
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${fileName}.recovery-link-qr.png`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function decodeRecoveryQrImage(file: File): Promise<string> {
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

    if (decoded.data.startsWith("https://") || decoded.data.startsWith("http://")) {
      const recoveryUrl = new URL(decoded.data);
      const isRecoveryRoute = [
        "/",
        "/preview",
        "/preview/",
        "/recovery",
        "/recovery/",
      ].includes(recoveryUrl.pathname);
      if (!trustedRecoveryOrigins().has(recoveryUrl.origin) || !isRecoveryRoute) {
        throw new Error("The QR code does not contain a SoverStore recovery link.");
      }
      const recoveryText = new URLSearchParams(
        recoveryUrl.hash.slice(1),
      ).get("recovery");
      if (!recoveryText) {
        throw new Error("The recovery link does not contain recovery data.");
      }
      parseRecovery(recoveryText);
      return recoveryText;
    }

    // Legacy QR images contain raw recovery JSON.
    parseRecovery(decoded.data);
    return decoded.data;
  } finally {
    bitmap.close();
  }
}
