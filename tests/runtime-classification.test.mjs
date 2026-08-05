import test from "node:test";
import assert from "node:assert/strict";
import {
  canRenderDropInterface,
  classifySoverStoreRuntime,
} from "../lib/runtime/runtime-classification.ts";

const base = {
  hostWebViewMark: false,
  productSdkHost: false,
  embeddedFrame: false,
  referrerHostname: null,
  publicGatewayHostname: "soverstore.dev-dot.li",
  mobilePresentation: false,
};

test("native host mark renders the real mobile Drop page", () => {
  const runtime = classifySoverStoreRuntime({
    ...base,
    hostWebViewMark: true,
    mobilePresentation: true,
  });
  assert.equal(runtime, "polkadot-mobile");
  assert.equal(canRenderDropInterface(runtime), true);
});

test("native host mark renders the real desktop Drop page", () => {
  const runtime = classifySoverStoreRuntime({ ...base, hostWebViewMark: true });
  assert.equal(runtime, "polkadot-desktop");
  assert.equal(canRenderDropInterface(runtime), true);
});

test("web gateway wins over its injected Product SDK bridge", () => {
  const runtime = classifySoverStoreRuntime({
    ...base,
    productSdkHost: true,
    referrerHostname: "soverstore.dev-dot.li",
  });
  assert.equal(runtime, "web-gateway");
  assert.equal(canRenderDropInterface(runtime), false);
});

test("an embedded Product without a native mark defaults to web fallback", () => {
  const runtime = classifySoverStoreRuntime({
    ...base,
    productSdkHost: true,
    embeddedFrame: true,
  });
  assert.equal(runtime, "web-gateway");
  assert.equal(canRenderDropInterface(runtime), false);
});

test("unknown runtime safely renders no wallet or transaction interface", () => {
  const runtime = classifySoverStoreRuntime(base);
  assert.equal(runtime, "unknown");
  assert.equal(canRenderDropInterface(runtime), false);
});
