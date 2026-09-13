import test from "node:test";
import assert from "node:assert/strict";
import {
  RESTART_GUARD_MS,
  restartWithNotice,
  takeRestartNotice,
} from "../lib/bulletin/restart-notice.ts";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    size: () => values.size,
  };
}

function environment(storage, { now = () => 1_000_000 } = {}) {
  const calls = { reloads: 0 };
  return { calls, env: { storage, now, reload: () => { calls.reloads += 1; } } };
}

test("a restart reloads the page and carries the reason across", () => {
  const storage = memoryStorage();
  const { calls, env } = environment(storage);

  assert.equal(restartWithNotice("Pokušaj ponovo", env), true);
  assert.equal(calls.reloads, 1);
  // The message has to survive a reload the page itself does not.
  assert.equal(takeRestartNotice(storage), "Pokušaj ponovo");
});

test("the reason is shown once, not on every later reload", () => {
  const storage = memoryStorage();
  restartWithNotice("Pokušaj ponovo", environment(storage).env);
  assert.equal(takeRestartNotice(storage), "Pokušaj ponovo");
  assert.equal(takeRestartNotice(storage), null);
});

test("a second failure inside the guard window does not reload again", () => {
  const storage = memoryStorage();
  let clock = 1_000_000;
  const { calls, env } = environment(storage, { now: () => clock });

  assert.equal(restartWithNotice("first", env), true);
  clock += RESTART_GUARD_MS - 1;
  // Reloading again would only cost the user the page they are reading.
  assert.equal(restartWithNotice("second", env), false);
  assert.equal(calls.reloads, 1);
});

test("once the window passes, a restart is allowed again", () => {
  const storage = memoryStorage();
  let clock = 1_000_000;
  const { calls, env } = environment(storage, { now: () => clock });

  restartWithNotice("first", env);
  clock += RESTART_GUARD_MS + 1;
  assert.equal(restartWithNotice("second", env), true);
  assert.equal(calls.reloads, 2);
  assert.equal(takeRestartNotice(storage), "second");
});

test("with no session storage the page is left alone", () => {
  // Losing the only explanation the user gets would be worse than staying put.
  const { calls, env } = environment(null);
  assert.equal(restartWithNotice("Pokušaj ponovo", env), false);
  assert.equal(calls.reloads, 0);
  assert.equal(takeRestartNotice(null), null);
});

test("unreadable storage contents do not surface as a notice", () => {
  const storage = memoryStorage({ "soverstore.restart-notice.v1": "{not json" });
  assert.equal(takeRestartNotice(storage), null);
});
