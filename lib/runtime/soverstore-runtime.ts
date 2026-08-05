import { DROP_SHARE_ORIGIN } from "@/lib/runtime-config";
import {
  classifySoverStoreRuntime,
  type SoverStoreRuntime,
} from "@/lib/runtime/runtime-classification";

type HostWindow = Window & {
  __HOST_WEBVIEW_MARK__?: boolean;
};

function hostnameOf(value: string): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

function isMobilePresentation(userAgent: string): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent);
}

export async function detectSoverStoreRuntime(): Promise<SoverStoreRuntime> {
  if (typeof window === "undefined") return "unknown";

  let productSdkHost = false;
  try {
    const { isInsideContainerSync } = await import("@parity/product-sdk");
    productSdkHost = isInsideContainerSync();
  } catch {
    // An unavailable bridge is an unknown runtime, never permission to render.
  }

  return classifySoverStoreRuntime({
    hostWebViewMark: (window as HostWindow).__HOST_WEBVIEW_MARK__ === true,
    productSdkHost,
    embeddedFrame: window.self !== window.top,
    referrerHostname: hostnameOf(document.referrer),
    publicGatewayHostname: hostnameOf(DROP_SHARE_ORIGIN) ?? "",
    mobilePresentation: isMobilePresentation(navigator.userAgent),
  });
}
