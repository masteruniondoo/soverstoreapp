import test from "node:test";
import assert from "node:assert/strict";
import { copyText } from "../lib/clipboard.ts";

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
