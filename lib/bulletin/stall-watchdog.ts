/**
 * Noticing that an upload has stopped moving.
 *
 * Every stage of an upload reports progress - authorization checks, encryption,
 * each signing request, each block. Silence is therefore the signal: when
 * nothing has been reported for a while, the run is not slow, it is stuck, and
 * no timeout inside the SDK is going to end it.
 *
 * Deliberately measured between progress reports rather than over the whole
 * upload: a large file is many chunks, and with Bulletin finality running tens
 * of seconds behind the best block a healthy upload legitimately takes minutes.
 * A total cap would cancel exactly those.
 *
 * Timers are injected so the behaviour can be tested without waiting.
 */

export type StallWatchdog = {
  /** Report a sign of life; restarts the countdown. */
  ping(): void;
  /** Stop watching, once the run has finished or been abandoned. */
  stop(): void;
};

export type WatchdogTimers = {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

const defaultTimers: WatchdogTimers = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function startStallWatchdog(
  timeoutMs: number,
  onStall: () => void,
  timers: WatchdogTimers = defaultTimers,
): StallWatchdog {
  let handle: unknown = null;
  let stopped = false;

  const arm = () => {
    if (stopped) return;
    handle = timers.setTimeout(() => {
      handle = null;
      // Fire once: the caller resets the run, and a second firing would land
      // on whatever the user started afterwards.
      stopped = true;
      onStall();
    }, timeoutMs);
  };

  const disarm = () => {
    if (handle !== null) {
      timers.clearTimeout(handle);
      handle = null;
    }
  };

  arm();

  return {
    ping() {
      if (stopped) return;
      disarm();
      arm();
    },
    stop() {
      stopped = true;
      disarm();
    },
  };
}
