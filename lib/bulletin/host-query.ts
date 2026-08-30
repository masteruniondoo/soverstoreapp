import { subscribeConnectionStatus } from "@parity/truapi/sandbox";

export const HOST_READY_TIMEOUT_MS = 5_000;
export const DIRECT_QUERY_TIMEOUT_MS = 8_000;
export const RETRY_DELAY_MS = 1_500;

const TIMEOUT_MARKER = "Bulletin host query timed out";

/**
 * Waits for the host transport to report "connected" before issuing a query.
 * Right after a wallet connect or a fresh document load, the host channel
 * handshake can still be settling; querying before it lands is what produces
 * a spurious hang/timeout that a plain retry does not fix, since it races the
 * same not-yet-ready channel again. Rejecting on timeout prevents a query
 * from being sent through a transport that never became ready.
 */
export function waitForHostConnected(
  timeoutMs: number = HOST_READY_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // The subscription callback may fire synchronously before assignment.
    // eslint-disable-next-line prefer-const
    let unsubscribe: (() => void) | undefined;
    let cleanupAfterSubscribe = false;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (unsubscribe) unsubscribe();
      else cleanupAfterSubscribe = true;
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            `${TIMEOUT_MARKER} after ${timeoutMs}ms while waiting for the host connection.`,
          ),
        ),
      timeoutMs,
    );
    unsubscribe = subscribeConnectionStatus((status) => {
      if (status === "connected") finish();
    });
    // subscribeConnectionStatus emits synchronously. If it reported connected
    // before returning its unsubscribe callback, release that listener now.
    if (cleanupAfterSubscribe) unsubscribe();
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bounds a host-routed PAPI operation with a local Promise timeout, without
 * aborting PAPI itself: AbortSignal cancellation emits a stop-operation host
 * frame that older Polkadot Desktop builds cannot decode, so a query that
 * times out is left to settle in the background rather than cancelled.
 */
export function withHostTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  stage: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(`${TIMEOUT_MARKER} after ${timeoutMs}ms while waiting for ${stage}.`),
        ),
      timeoutMs,
    );
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function isHostQueryTimeout(error: unknown): boolean {
  return error instanceof Error && error.message.includes(TIMEOUT_MARKER);
}

/**
 * Runs a host-routed query with the full readiness/timeout/retry treatment:
 * wait for the host transport, run once, and on a non-timeout failure reset
 * the Bulletin client and retry once more. A timed-out query is left alone
 * (see withHostTimeout) and rethrown for the caller to route into
 * recoverTimedOutBulletinTransport.
 */
export async function runHostQuery<T>(
  run: () => Promise<T>,
  reset: () => Promise<void>,
  label: string,
): Promise<T> {
  await waitForHostConnected();
  try {
    return await run();
  } catch (error) {
    console.warn(`[soverstore:bulletin] ${label} attempt failed`, {
      attempt: 1,
      error: error instanceof Error ? error.message : String(error),
    });
    if (isHostQueryTimeout(error)) throw error;

    await reset();
    await delay(RETRY_DELAY_MS);
    await waitForHostConnected();
    try {
      return await run();
    } catch (retryError) {
      console.warn(`[soverstore:bulletin] ${label} attempt failed`, {
        attempt: 2,
        error: retryError instanceof Error ? retryError.message : String(retryError),
      });
      throw retryError;
    }
  }
}
