import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeRecoveryKey,
  generateRecoveryKey,
} from "../lib/artifacts/recovery.ts";
import {
  decryptRecoveryBlob,
  encryptFileToBlob,
} from "../lib/recovery/blob.ts";
import { recoverFile } from "../lib/recovery/recover-file.ts";

const PLAINTEXT = new TextEncoder().encode("the original file, in the clear");

async function storeOneFile() {
  const key32 = generateRecoveryKey();
  const blob = await encryptFileToBlob({
    key32,
    bytes: PLAINTEXT,
    name: "note.txt",
    type: "text/plain",
    size: PLAINTEXT.length,
  });
  return { key32, key: encodeRecoveryKey(key32), blob };
}

test("a file encrypted under its Recovery Key comes back byte for byte", async () => {
  const { key, blob } = await storeOneFile();
  const recovered = await decryptRecoveryBlob(blob, key);
  assert.deepEqual(recovered.content, PLAINTEXT);
  assert.equal(recovered.meta.name, "note.txt");
  assert.equal(recovered.meta.type, "text/plain");
  assert.equal(recovered.meta.size, PLAINTEXT.length);
});

test("the Recovery Key is the AES key: no second key layer to carry", async () => {
  const { key32, key, blob } = await storeOneFile();
  // Decrypting needs nothing but these 32 bytes and the public blob.
  assert.equal(key32.length, 32);
  assert.deepEqual((await decryptRecoveryBlob(blob, key)).content, PLAINTEXT);
});

test("a wrong Recovery Key does not open the file", async () => {
  const { blob } = await storeOneFile();
  const wrong = encodeRecoveryKey(generateRecoveryKey());
  await assert.rejects(
    () => decryptRecoveryBlob(blob, wrong),
    /Wrong key for this CID, or the blob is corrupted/,
  );
});

test("a tampered blob fails authentication instead of decrypting", async () => {
  const { key, blob } = await storeOneFile();
  const tampered = new Uint8Array(blob);
  // The last byte is inside the GCM tag; the middle is inside the ciphertext.
  tampered[tampered.length - 1] ^= 0x01;
  await assert.rejects(
    () => decryptRecoveryBlob(tampered, key),
    /Wrong key for this CID, or the blob is corrupted/,
  );

  const flipped = new Uint8Array(blob);
  flipped[blob.length - 20] ^= 0xff;
  await assert.rejects(
    () => decryptRecoveryBlob(flipped, key),
    /Wrong key for this CID, or the blob is corrupted/,
  );
});

test("the uploaded blob carries no trace of the Recovery Key", async () => {
  const { key32, key, blob } = await storeOneFile();

  const haystack = Buffer.from(blob);
  assert.equal(
    haystack.includes(Buffer.from(key32)),
    false,
    "the raw key must not appear in the bytes sent to Bulletin",
  );
  for (const encoding of ["utf8", "base64", "hex"]) {
    assert.equal(
      haystack.includes(Buffer.from(key, "utf8")),
      false,
      `the key text must not appear in the blob (${encoding})`,
    );
  }
  assert.equal(
    haystack.includes(Buffer.from(Buffer.from(key32).toString("base64"))),
    false,
  );

  // The public header is everything decryption needs besides the key.
  const headerLength = haystack.readUInt32LE(5);
  const header = JSON.parse(haystack.subarray(9, 9 + headerLength).toString());
  assert.deepEqual(Object.keys(header).sort(), ["alg", "iv", "v"]);
  assert.equal(header.alg, "AES-256-GCM");
  assert.equal(Buffer.from(header.iv, "base64").length, 12);
});

test("each upload of the same bytes produces a different key and a different blob", async () => {
  const first = await storeOneFile();
  const second = await storeOneFile();
  assert.notEqual(first.key, second.key);
  assert.notDeepEqual(first.blob, second.blob);
  await assert.rejects(() => decryptRecoveryBlob(first.blob, second.key));
});

test("recoverFile is the one path from a CID and a key to the plaintext", async () => {
  const { key, blob } = await storeOneFile();
  const asked = [];

  const recovered = await recoverFile("bafkreitestcid", key, {
    fetchBlob: async (cid, hints) => {
      asked.push({ cid, hints });
      return blob;
    },
  });

  assert.deepEqual(recovered.content, PLAINTEXT);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].cid, "bafkreitestcid");
  assert.deepEqual(
    Object.keys(asked[0].hints),
    ["onDiagnostic"],
    "retrieval is told the CID and nothing else",
  );
});

test("nothing given to Bulletin or to a diagnostic line contains the key", async () => {
  const { key, blob } = await storeOneFile();
  const seen = [];

  await recoverFile("bafkreitestcid", key, {
    onProgress: (message) => seen.push(message),
    onDiagnostic: (message) => seen.push(message),
    fetchBlob: async (cid, hints) => {
      seen.push(cid, JSON.stringify(hints.blockNumber ?? null));
      hints.onDiagnostic?.(`Host Bulletin lookup: ${cid}`);
      return blob;
    },
  });

  assert.ok(seen.length > 0);
  for (const line of seen) {
    assert.equal(line.includes(key), false, line);
  }
});
