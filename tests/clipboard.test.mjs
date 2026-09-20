import test from "node:test";
import assert from "node:assert/strict";
import { copyImage, copyText } from "../lib/clipboard.ts";

function paths({ writeText = null, legacyCopy = () => true } = {}) {
  const calls = { writeText: 0, legacy: 0, copied: null };
  return {
    calls,
    paths: {
      writeText: writeText === null ? null : (text) => {
        calls.writeText += 1;
        calls.copied = text;
        return writeText(text);
      },
      legacyCopy: (text) => {
        calls.legacy += 1;
        calls.copied = text;
        return legacyCopy(text);
      },
    },
  };
}

test("the modern clipboard is used when the browser allows it", async () => {
  const env = paths({ writeText: async () => {} });
  assert.equal(await copyText("secret", env.paths), true);
  assert.equal(env.calls.writeText, 1);
  assert.equal(env.calls.legacy, 0, "no need to touch the deprecated path");
  assert.equal(env.calls.copied, "secret");
});

test("a clipboard denied by Permissions Policy falls back instead of failing", async () => {
  // What the gateway's cross-origin sandbox does: the API exists and rejects.
  const env = paths({
    writeText: async () => { throw new DOMException("denied", "NotAllowedError"); },
  });
  assert.equal(await copyText("secret", env.paths), true);
  assert.equal(env.calls.writeText, 1);
  assert.equal(env.calls.legacy, 1);
});

test("a browser exposing no clipboard API goes straight to the fallback", async () => {
  const env = paths({ writeText: null });
  assert.equal(await copyText("secret", env.paths), true);
  assert.equal(env.calls.legacy, 1);
});

test("when both paths fail the caller is told, not reassured", async () => {
  const env = paths({
    writeText: async () => { throw new Error("nope"); },
    legacyCopy: () => false,
  });
  assert.equal(await copyText("secret", env.paths), false);
});

/**
 * `Copy QR Code` copies a picture when it can. There is no `execCommand`
 * equivalent for images, so the only honest answer where it cannot is false -
 * the button then copies the recovery link instead.
 */
function imagePaths({ write = null, createItem = (type, blob) => ({ type, blob }) } = {}) {
  const calls = { write: 0, created: [] };
  return {
    calls,
    paths: {
      write: write === null ? null : (items) => {
        calls.write += 1;
        return write(items);
      },
      createItem: createItem === null ? null : (type, blob) => {
        calls.created.push(type);
        return createItem(type, blob);
      },
    },
  };
}

const PNG = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], {
  type: "image/png",
});

test("the QR image reaches the clipboard where the browser allows it", async () => {
  const env = imagePaths({ write: async () => {} });
  assert.equal(await copyImage(PNG, env.paths), true);
  assert.equal(env.calls.write, 1);
  assert.deepEqual(env.calls.created, ["image/png"]);
});

test("a browser with no image clipboard reports failure instead of pretending", async () => {
  assert.equal(await copyImage(PNG, imagePaths({ write: null }).paths), false);
  assert.equal(
    await copyImage(PNG, imagePaths({ createItem: null }).paths),
    false,
  );
});

test("a denied image write is reported, so the caller can copy the link", async () => {
  const env = imagePaths({
    write: async () => { throw new DOMException("denied", "NotAllowedError"); },
  });
  assert.equal(await copyImage(PNG, env.paths), false);
  assert.equal(env.calls.write, 1);
});
