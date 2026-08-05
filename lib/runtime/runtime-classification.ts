export type SoverStoreRuntime =
  | "polkadot-mobile"
  | "polkadot-desktop"
  | "web-gateway"
  | "unknown";

export type RuntimeSignals = {
  hostWebViewMark: boolean;
  productSdkHost: boolean;
  embeddedFrame: boolean;
  referrerHostname: string | null;
  publicGatewayHostname: string;
  mobilePresentation: boolean;
};

export function classifySoverStoreRuntime(
  signals: RuntimeSignals,
): SoverStoreRuntime {
  // The native host mark is the strongest signal exposed by the current host.
  if (signals.hostWebViewMark) {
    return signals.mobilePresentation
      ? "polkadot-mobile"
      : "polkadot-desktop";
  }

  // dev-dot.li embeds Products in an iframe and also installs the Product SDK
  // bridge. Its exact referrer must therefore be checked before accepting the
  // generic SDK-host signal as a native Polkadot container.
  if (
    signals.embeddedFrame ||
    signals.referrerHostname === signals.publicGatewayHostname
  ) {
    return "web-gateway";
  }

  if (signals.productSdkHost) {
    return signals.mobilePresentation
      ? "polkadot-mobile"
      : "polkadot-desktop";
  }

  return "unknown";
}

export function canRenderDropInterface(runtime: SoverStoreRuntime): boolean {
  return runtime === "polkadot-mobile" || runtime === "polkadot-desktop";
}
