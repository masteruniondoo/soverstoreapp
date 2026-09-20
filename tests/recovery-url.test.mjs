import test from "node:test";
import assert from "node:assert/strict";
import {
  RECOVERY_ROUTE,
  encodeRecoveryKey,
  generateRecoveryKey,
  isRecoveryRoutePath,
  parseRecoveryUrl,
  recoveryAppOrigin,
  recoveryUrl,
} from "../lib/artifacts/recovery.ts";
import { recoveryQrPayload } from "../lib/artifacts/recovery-qr.ts";

const CID = "bafkreianysoverstoretestcidvalue";
const KEY = encodeRecoveryKey(generateRecoveryKey());
const DETAILS = { cid: CID, key: KEY };

test("a recovery link opens the Recover route on this deployment's origin", () => {
  const url = new URL(recoveryUrl(DETAILS));
  assert.equal(url.origin, recoveryAppOrigin());
  assert.equal(url.pathname, RECOVERY_ROUTE);
  assert.ok(isRecoveryRoutePath(url.pathname));
  assert.equal(url.searchParams.get("cid"), CID);
});

test("the Recovery Key rides in the fragment and never in the query string", () => {
  const url = new URL(recoveryUrl(DETAILS));

  // The fragment is not put on the wire, so the key stays out of request
  // logs, proxy logs, and Referer headers. This is the whole point of the
  // format; a change that moves the key into the query leaks it everywhere.
  assert.equal(new URLSearchParams(url.hash.slice(1)).get("key"), KEY);
  assert.equal(url.search.includes(KEY), false);
  assert.equal(url.searchParams.get("key"), null);
  assert.equal(`${url.origin}${url.pathname}${url.search}`.includes(KEY), false);
});

test("a recovery link reads back as the same CID and key", () => {
  assert.deepEqual(parseRecoveryUrl(recoveryUrl(DETAILS)), DETAILS);
});

test("a link that carries the key in the query is not a recovery link", () => {
  const origin = recoveryAppOrigin();
  assert.throws(
    () => parseRecoveryUrl(`${origin}${RECOVERY_ROUTE}?cid=${CID}&key=${KEY}`),
    /missing its CID or Recovery Key/,
  );
});

test("an incomplete or malformed link is refused", () => {
  const origin = recoveryAppOrigin();
  assert.throws(
    () => parseRecoveryUrl(`${origin}${RECOVERY_ROUTE}#key=${KEY}`),
    /missing its CID/,
  );
  assert.throws(
    () => parseRecoveryUrl(`${origin}${RECOVERY_ROUTE}?cid=${CID}`),
    /missing its CID or Recovery Key/,
  );
  assert.throws(() => parseRecoveryUrl("recover this please"), /not a SoverStore recovery link/);
});

test("the QR encodes exactly the recovery link", () => {
  const payload = recoveryQrPayload(DETAILS);
  assert.equal(payload, recoveryUrl(DETAILS));
  // Enough on its own to open the page, name the file, and decrypt it.
  assert.deepEqual(parseRecoveryUrl(payload), DETAILS);
});

test("an explicit origin is honoured, so a deployment is never hardcoded", () => {
  const url = new URL(recoveryUrl(DETAILS, "https://example.test/"));
  assert.equal(url.origin, "https://example.test");
  assert.equal(url.pathname, RECOVERY_ROUTE);
});

test("a recovery link pins the host to trusted RPC servers", () => {
  // Without this the Polkadot host resolves the domain through an in-browser
  // light client, whose synced view can predate the current deploy - the app
  // then opens on an older bundle. A recovery link is opened rarely, often on
  // a device that has never loaded the app; it cannot wait for a sync.
  const url = new URL(recoveryUrl(DETAILS));
  assert.equal(url.searchParams.get("chainBackend"), "rpc-gateway");
  // It is a host parameter, so it belongs in the query, not the fragment.
  assert.equal(url.hash.includes("chainBackend"), false);
});

test("the host parameter does not disturb reading the link back", () => {
  assert.deepEqual(parseRecoveryUrl(recoveryUrl(DETAILS)), DETAILS);
});
