import test from "node:test";
import assert from "node:assert/strict";
import { startStallWatchdog } from "../lib/bulletin/stall-watchdog.ts";

/** Timers under the test's control: nothing here waits in real time. */
function fakeTimers() {
  let next = 1;
  const pending = new Map();
  return {
    timers: {
      setTimeout: (handler, ms) => {
        const id = next++;
        pending.set(id, { handler, ms });
        return id;
      },
      clearTimeout: (id) => pending.delete(id),
    },
    get armed() {
      return pending.size;
    },
    /** Run every timer currently armed, as if its delay had elapsed. */
    fire() {
      for (const [id, { handler }] of [...pending]) {
        pending.delete(id);
        handler();
      }
    },
    delays() {
      return [...pending.values()].map((t) => t.ms);
    },
  };
}

test("a run that reports nothing is declared stalled", () => {
  const clock = fakeTimers();
  let stalls = 0;
  startStallWatchdog(60_000, () => { stalls += 1; }, clock.timers);
  assert.deepEqual(clock.delays(), [60_000]);
  clock.fire();
  assert.equal(stalls, 1);
});

test("every report restarts the countdown", () => {
  const clock = fakeTimers();
  let stalls = 0;
  const watchdog = startStallWatchdog(60_000, () => { stalls += 1; }, clock.timers);

  // Three signs of life: the timer is replaced each time, never stacked.
  watchdog.ping();
  watchdog.ping();
  watchdog.ping();
  assert.equal(clock.armed, 1);
  assert.equal(stalls, 0);

  clock.fire();
  assert.equal(stalls, 1);
});

test("a finished run stops being watched", () => {
  const clock = fakeTimers();
  let stalls = 0;
  const watchdog = startStallWatchdog(60_000, () => { stalls += 1; }, clock.timers);
  watchdog.stop();
  assert.equal(clock.armed, 0);
  clock.fire();
  assert.equal(stalls, 0);
});

test("a ping after stop does not re-arm the watchdog", () => {
  const clock = fakeTimers();
  let stalls = 0;
  const watchdog = startStallWatchdog(60_000, () => { stalls += 1; }, clock.timers);
  watchdog.stop();
  // A late progress report from the abandoned run must not revive it.
  watchdog.ping();
  assert.equal(clock.armed, 0);
  clock.fire();
  assert.equal(stalls, 0);
});

test("it fires once, never onto whatever the user started next", () => {
  const clock = fakeTimers();
  let stalls = 0;
  const watchdog = startStallWatchdog(60_000, () => { stalls += 1; }, clock.timers);
  clock.fire();
  watchdog.ping();
  clock.fire();
  assert.equal(stalls, 1);
});
