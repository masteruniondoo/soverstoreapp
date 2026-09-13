import test from "node:test";
import assert from "node:assert/strict";
import {
  NATIVE_HOST_CHUNK_SIZE,
  PAIRED_WALLET_CHUNK_SIZE,
  signingLimits,
} from "../lib/bulletin/signing-limits.ts";

// Measured against the live runtime: call data is the chunk plus a 6-byte
// preamble, and it travels as a hex string at two characters per byte.
const CALL_PREAMBLE_BYTES = 6;

test("Desktop and the mobile app keep the chunk size that has always worked there", () => {
  assert.equal(signingLimits("polkadot-desktop").chunkSize, NATIVE_HOST_CHUNK_SIZE);
  assert.equal(signingLimits("polkadot-mobile").chunkSize, NATIVE_HOST_CHUNK_SIZE);
});

test("the web gateway signs through a paired phone, so it gets the smaller chunk", () => {
  assert.equal(signingLimits("web-gateway").chunkSize, PAIRED_WALLET_CHUNK_SIZE);
});

test("an unknown runtime is treated as the paired phone, not as Desktop", () => {
  // Guessing high costs an upload that hangs after the user approved it;
  // guessing low only costs extra approvals.
  assert.equal(signingLimits("unknown").chunkSize, PAIRED_WALLET_CHUNK_SIZE);
});

test("the gateway chunk stays inside the size proven to sign over a pairing", () => {
  // A file under 32 KB uploaded successfully; 128 KiB chunks did not.
  const { chunkSize } = signingLimits("web-gateway");
  assert.ok(chunkSize + CALL_PREAMBLE_BYTES < 32 * 1024, "call data must stay under the proven 32 KB");
  assert.ok(chunkSize < NATIVE_HOST_CHUNK_SIZE);
});

test("the call-data ceiling admits the chunk itself but never a second one", () => {
  for (const runtime of ["polkadot-desktop", "web-gateway"]) {
    const { chunkSize, maxCallData } = signingLimits(runtime);
    assert.ok(maxCallData > chunkSize + CALL_PREAMBLE_BYTES, `${runtime}: real call data must pass`);
    assert.ok(maxCallData < chunkSize * 2, `${runtime}: a doubled payload must be refused`);
  }
});
