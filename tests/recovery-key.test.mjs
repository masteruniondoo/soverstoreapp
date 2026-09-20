import test from "node:test";
import assert from "node:assert/strict";
import {
  CID_LABEL,
  RECOVERY_KEY_BYTES,
  RECOVERY_KEY_LABEL,
  decodeRecoveryKey,
  encodeRecoveryKey,
  formatRecoveryText,
  generateRecoveryKey,
  normalizeRecoveryDetails,
  parseRecoveryText,
} from "../lib/artifacts/recovery.ts";
import { parseRecoveryInput } from "../lib/artifacts/recovery-input.ts";

const CID = "bafkreianysoverstoretestcidvalue";

test("a Recovery Key is 256 bits", () => {
  assert.equal(RECOVERY_KEY_BYTES, 32);
  assert.equal(generateRecoveryKey().length, 32);
});

test("every file gets its own key", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    seen.add(encodeRecoveryKey(generateRecoveryKey()));
  }
  assert.equal(seen.size, 200, "no key may ever be handed out twice");
});

test("keys are written as Base64URL without padding", () => {
  // 0xFB 0xFF exercise the two bytes standard Base64 spells with + and /.
  const key = new Uint8Array(32).fill(0xfb);
  key[1] = 0xff;
  const encoded = encodeRecoveryKey(key);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/, "must survive a URL fragment");
  assert.ok(!encoded.includes("="), "no padding to be truncated or escaped");
  assert.deepEqual(decodeRecoveryKey(encoded), key);
});

test("a key is rejected unless it is exactly 32 bytes", () => {
  assert.throws(() => encodeRecoveryKey(new Uint8Array(16)), /32 bytes/);
  assert.throws(
    () => decodeRecoveryKey(encodeRecoveryKey(new Uint8Array(32)).slice(0, 20)),
    /32 bytes/,
  );
  assert.throws(() => decodeRecoveryKey(""), /required/);
  assert.throws(() => decodeRecoveryKey("not a key!!"), /Base64URL/);
});

test("standard Base64 keys are still accepted, so old keys keep working", () => {
  const key = generateRecoveryKey();
  const legacy = Buffer.from(key).toString("base64");
  assert.ok(legacy.endsWith("="), "the retired encoding padded its keys");
  assert.deepEqual(decodeRecoveryKey(legacy), key);
  // And they come back out in the one canonical form.
  assert.equal(
    normalizeRecoveryDetails({ cid: CID, key: legacy }).key,
    encodeRecoveryKey(key),
  );
});

test("Copy Recovery writes a CID line and a Recovery Key line", () => {
  const key = encodeRecoveryKey(generateRecoveryKey());
  const text = formatRecoveryText({ cid: CID, key });
  assert.equal(text, `${CID_LABEL}: ${CID}\n${RECOVERY_KEY_LABEL}: ${key}`);
  assert.deepEqual(parseRecoveryText(text), { cid: CID, key });
});

test("pasted recovery information is read back whatever shape it arrives in", () => {
  const key = encodeRecoveryKey(generateRecoveryKey());
  const expected = { cid: CID, key };

  for (const pasted of [
    formatRecoveryText(expected),
    `${RECOVERY_KEY_LABEL}: ${key}\n${CID_LABEL}: ${CID}`,
    `Bulletin CID: ${CID}\nkey = ${key}`,
    `SoverStore recovery\n\n  CID:  ${CID}  \n  Recovery Key:  ${key}  \n`,
    `${CID} ${key}`,
  ]) {
    assert.deepEqual(parseRecoveryInput(pasted), expected, pasted);
  }
});

test("half a recovery is refused rather than half-recovered", () => {
  const key = encodeRecoveryKey(generateRecoveryKey());
  assert.throws(() => parseRecoveryInput(`${CID_LABEL}: ${CID}`), /Copy Recovery/);
  assert.throws(() => parseRecoveryInput(`${RECOVERY_KEY_LABEL}: ${key}`), /Copy Recovery/);
  assert.throws(() => parseRecoveryInput("   "), /Paste your recovery/);
  assert.throws(
    () => normalizeRecoveryDetails({ cid: "", key }),
    /Bulletin CID is required/,
  );
  assert.throws(
    () => normalizeRecoveryDetails({ cid: "not a cid!", key }),
    /does not look like a Bulletin CID/,
  );
});

test("a recovery document from before the change still opens", () => {
  const key = generateRecoveryKey();
  const legacy = JSON.stringify({
    format: "proofbox/recovery@1",
    cid: CID,
    key: Buffer.from(key).toString("base64"),
    blobSize: 1234,
    chain: { blockNumber: 42, extrinsicIndex: 1 },
  });
  assert.deepEqual(parseRecoveryInput(legacy), {
    cid: CID,
    key: encodeRecoveryKey(key),
  });
});
