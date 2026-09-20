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
