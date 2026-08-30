"use client";

import { useEffect, useRef, useState } from "react";
import { tryDecodeRecoveryQrFrame } from "@/lib/artifacts/recovery-qr";

export function RecoveryQrScanner({
  onDecoded,
  onClose,
}: {
  onDecoded: (text: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const onDecodedRef = useRef(onDecoded);
  onDecodedRef.current = onDecoded;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    let rafId: number | null = null;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });

    const scanFrame = () => {
      const video = videoRef.current;
      if (video && context && video.readyState >= video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        const decoded = tryDecodeRecoveryQrFrame(image);
        if (decoded) {
          onDecodedRef.current(decoded);
          return;
        }
      }
      rafId = requestAnimationFrame(scanFrame);
    };

    void (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error(
            "This browser or host does not expose camera access.",
          );
        }
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        rafId = requestAnimationFrame(scanFrame);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Could not access the camera.",
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  return (
    <div className="qr-scanner">
      <div className="qr-scanner-frame">
        <video ref={videoRef} className="qr-scanner-video" muted playsInline />
        <div className="qr-scanner-reticle" aria-hidden />
      </div>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : (
        <p className="qr-scanner-hint">
          Point the camera at a SoverStore recovery QR code.
        </p>
      )}
      <button className="btn btn-ghost" type="button" onClick={onClose}>
        Cancel
      </button>
    </div>
  );
}
