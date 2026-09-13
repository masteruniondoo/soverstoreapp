/**
 * Starting the next upload on a genuinely clean page.
 *
 * Clearing this app's own caches is not enough after an upload is abandoned.
 * The host wallet session, the chain client's transaction pool, the PAPI
 * subscriptions and the Desktop MessagePort all live outside anything this
 * code can reach, and an upload that died partway leaves them in a state the
 * next attempt inherits: the wallet stops answering signing requests, and it
 * stays that way for uploads that follow. The rest of this codebase already
 * concluded the same thing about a dead host transport - "a document reload is
 * the supported way to ask Desktop for a fresh port".
 *
 * So starting over reloads the document. The message the user needs to read
 * would not survive that, so it is handed across in session storage and shown
 * once the new page is up.
 *
 * A reload that does not fix anything must not become a loop, so a restart is
 * allowed only once per guard window; after that the caller shows the message
 * in place and leaves the page alone.
 */

const NOTICE_KEY = "soverstore.restart-notice.v1";
const LAST_RESTART_KEY = "soverstore.restart-at.v1";

/** Two uploads cannot plausibly fail this close together for unrelated reasons. */
export const RESTART_GUARD_MS = 90_000;

export type RestartStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

export type RestartEnvironment = {
  storage: RestartStorage | null;
  reload: () => void;
  now: () => number;
};

/**
 * Reads the message left by a restart, clearing it so a later reload for an
 * unrelated reason does not show it again.
 */
export function takeRestartNotice(storage: RestartStorage | null): string | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(NOTICE_KEY);
    if (raw === null) return null;
    storage.removeItem(NOTICE_KEY);
    const parsed = JSON.parse(raw) as { message?: unknown };
    return typeof parsed.message === "string" ? parsed.message : null;
  } catch {
    return null;
  }
}

/**
 * Reloads the page, carrying `message` across, unless a restart already
 * happened inside the guard window.
 *
 * Returns whether the reload was started: `false` means the caller is on its
 * own and should show the message in place.
 */
export function restartWithNotice(
  message: string,
  environment: RestartEnvironment,
): boolean {
  const { storage, reload, now } = environment;
  if (!storage) return false;

  try {
    const last = Number(storage.getItem(LAST_RESTART_KEY) ?? "0");
    if (Number.isFinite(last) && last > 0 && now() - last < RESTART_GUARD_MS) {
      // Reloading again would only cost the user the page they are reading.
      return false;
    }
    storage.setItem(LAST_RESTART_KEY, String(now()));
    storage.setItem(NOTICE_KEY, JSON.stringify({ message, at: now() }));
  } catch {
    // Session storage can be unavailable; a reload without the message would
    // lose the only explanation the user gets, so stay on the page instead.
    return false;
  }

  reload();
  return true;
}
