import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDropAppLink,
  parseDropAppLink,
  parseDropEntryValue,
  parseDropHash,
  parseDropPathname,
  parseDropUrl,
  resolveDropLocation,
  validateDropId,
} from "../lib/drops/drop-route.ts";

const origin = "https://soverstore.dev-dot.li";

test("builds and parses the app-only Browse link", () => {
  assert.equal(buildDropAppLink("7"), "soverstore.dot/drop/7");
  assert.deepEqual(parseDropAppLink("soverstore.dot/drop/7#/drop/7"), {
    kind: "drop",
    dropId: "7",
  });
  assert.deepEqual(parseDropAppLink("soverstore.dot/#/drop/7"), {
    kind: "drop",
    dropId: "7",
  });
  assert.deepEqual(parseDropAppLink("https://soverstore.dot/#/drop/%37"), {
    kind: "drop",
    dropId: "7",
  });
  assert.equal(
    parseDropAppLink("soverstore.dot/drop/7#/drop/8").kind,
    "invalid",
  );
  // Continue accepting links copied by older SoverStore versions.
  assert.deepEqual(parseDropAppLink("soverstore.dot/drop/7"), {
    kind: "drop",
    dropId: "7",
  });
  assert.deepEqual(parseDropAppLink("HTTPS://SOVERSTORE.DOT/drop/%37"), {
    kind: "drop",
    dropId: "7",
  });
  assert.deepEqual(parseDropAppLink("polkadot://soverstore.dot/drop/7"), {
    kind: "drop",
    dropId: "7",
  });
  assert.deepEqual(parseDropAppLink("\u200Bsoverstore.dot/drop/7\n"), {
    kind: "drop",
    dropId: "7",
  });
  assert.equal(parseDropAppLink("soverstore.dot/drop/0").kind, "invalid");
  assert.equal(parseDropAppLink("soverstore.dot/drop/7/extra").kind, "invalid");
  assert.throws(() => buildDropAppLink("not-an-id"), /valid Drop ID/);
});

test("tolerates a www. prefix and tracking query params added by chat apps", () => {
  assert.deepEqual(parseDropAppLink("https://www.soverstore.dot/drop/7"), {
    kind: "drop",
    dropId: "7",
  });
  assert.deepEqual(
    parseDropAppLink("https://soverstore.dot/drop/7?utm_source=telegram"),
    { kind: "drop", dropId: "7" },
  );
  assert.deepEqual(
    parseDropAppLink("www.soverstore.dot/drop/7?x=1#/drop/7"),
    { kind: "drop", dropId: "7" },
  );
});

test("resolves the mobile-safe Drop fragment", () => {
  assert.deepEqual(parseDropHash("#/drop/7"), {
    kind: "drop",
    dropId: "7",
  });
  assert.deepEqual(parseDropHash("#/drop/%37"), {
    kind: "drop",
    dropId: "7",
  });
  assert.equal(parseDropHash("#/drop/0").kind, "invalid");
  assert.equal(parseDropHash("#/drop/7/more").kind, "invalid");
  assert.equal(parseDropHash("#section").kind, "not-drop");
});

test("accepts a valid Drop host and path", () => {
  assert.deepEqual(parseDropUrl(`${origin}/drop/7`, origin), {
    kind: "drop",
    dropId: "7",
  });
});

test("accepts an encoded numeric Drop identifier", () => {
  assert.deepEqual(parseDropUrl(`${origin}/drop/%37`, origin), {
    kind: "drop",
    dropId: "7",
  });
});

test("rejects a wrong domain", () => {
  assert.equal(parseDropUrl("https://evil.example/drop/7", origin).kind, "invalid");
});

test("rejects wrong, missing, and additional paths", () => {
  assert.equal(parseDropUrl(`${origin}/drops/7`, origin).kind, "invalid");
  assert.equal(parseDropUrl(`${origin}/drop/`, origin).kind, "invalid");
  assert.equal(parseDropUrl(`${origin}/drop/7/more`, origin).kind, "invalid");
});

test("rejects malformed URLs and encoded path separators", () => {
  assert.equal(parseDropUrl("not a URL", origin).kind, "invalid");
  assert.equal(parseDropUrl(`${origin}/drop/7%2F8`, origin).kind, "invalid");
});

test("accepts only positive uint256 IDs", () => {
  assert.equal(validateDropId("1"), "1");
  assert.equal(validateDropId("0"), null);
  assert.equal(validateDropId("7xK2p"), null);
  assert.equal(validateDropId((1n << 256n).toString()), null);
  assert.equal(parseDropPathname("/unrelated").kind, "not-drop");
});

test("manual entry accepts an app link, legacy URL, or bare Drop ID", () => {
  assert.deepEqual(parseDropEntryValue(" 7 ", origin), {
    kind: "drop",
    dropId: "7",
  });
  assert.deepEqual(parseDropEntryValue(`${origin}/drop/7`, origin), {
    kind: "drop",
    dropId: "7",
  });
  assert.deepEqual(parseDropEntryValue("soverstore.dot/drop/7", origin), {
    kind: "drop",
    dropId: "7",
  });
  assert.deepEqual(parseDropEntryValue("soverstore.dot/#/drop/7", origin), {
    kind: "drop",
    dropId: "7",
  });
  assert.deepEqual(
    parseDropEntryValue("soverstore.dot/drop/7#/drop/7", origin),
    { kind: "drop", dropId: "7" },
  );
  assert.deepEqual(parseDropEntryValue("https://soverstore.dot/drop/7", origin), {
    kind: "drop",
    dropId: "7",
  });
  assert.equal(
    parseDropEntryValue("https://evil.example/drop/7", origin).kind,
    "invalid",
  );
});

test("recovers a stripped Drop route only from the canonical referrer", () => {
  assert.deepEqual(resolveDropLocation("/", `${origin}/drop/7`, origin), {
    kind: "drop",
    dropId: "7",
  });
  assert.deepEqual(
    resolveDropLocation("/", "https://evil.example/drop/8", origin),
    { kind: "not-drop" },
  );
  assert.deepEqual(resolveDropLocation("/drops", `${origin}/drop/7`, origin), {
    kind: "not-drop",
  });
});

test("recovers a mobile Drop route from the root document fragment", () => {
  assert.deepEqual(resolveDropLocation("/", "", origin, "#/drop/7"), {
    kind: "drop",
    dropId: "7",
  });
  assert.deepEqual(resolveDropLocation("/", "", origin, "#unrelated"), {
    kind: "not-drop",
  });
});
