"use client";

import { useEffect } from "react";

const STORAGE_KEY_PREFIX = "soverstore:chunk-load-recovery";

function reasonText(reason: unknown): string {
  if (reason instanceof Error) {
    return `${reason.name} ${reason.message}`;
  }

  if (typeof reason === "string") {
    return reason;
  }

  if (reason && typeof reason === "object") {
    const errorLike = reason as {
      message?: unknown;
      name?: unknown;
      request?: unknown;
      type?: unknown;
    };

    return [
      errorLike.name,
      errorLike.message,
      errorLike.request,
      errorLike.type,
    ]
      .filter((value): value is string => typeof value === "string")
      .join(" ");
  }

  return "";
}

function isChunkLoadError(reason: unknown): boolean {
  const text = reasonText(reason);

  return (
    /ChunkLoadError/i.test(text) ||
    /Loading chunk \d+ failed/i.test(text) ||
    /\/_next\/static\/chunks\/.*\.js/i.test(text)
  );
}

function currentRuntimeKey(): string {
  const webpackRuntime = Array.from(document.scripts)
    .map((script) => script.src)
    .find((src) => src.includes("/_next/static/chunks/webpack-"));

  return `${STORAGE_KEY_PREFIX}:${webpackRuntime ?? window.location.pathname}`;
}

function reloadOnceForCurrentBuild() {
  const key = currentRuntimeKey();

  try {
    if (window.sessionStorage.getItem(key) === "1") {
      return;
    }

    window.sessionStorage.setItem(key, "1");
  } catch {
    return;
  }

  window.location.reload();
}

export function ChunkLoadRecovery() {
  useEffect(() => {
    const recover = (reason: unknown) => {
      if (isChunkLoadError(reason)) {
        reloadOnceForCurrentBuild();
      }
    };

    const onError = (event: ErrorEvent) => {
      recover(event.error ?? event.message);
    };

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      recover(event.reason);
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);

    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  return null;
}
