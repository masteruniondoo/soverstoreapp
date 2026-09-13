/**
 * Discarding everything an interrupted upload left behind.
 *
 * A cancelled or failed upload leaves state in three places, and a retry that
 * inherits any of it does not really start over:
 *
 *  - the cached Bulletin client, which may be holding a host transport that is
 *    already unusable (that is what makes a second attempt fail the same way);
 *  - the in-flight allowance lookup, which would hand the retry a promise from
 *    the abandoned run instead of reading the chain again;
 *  - the transport-recovery marker, which exists to survive one reload and
 *    would otherwise suppress a legitimate recovery later.
 *
 * What is already on Bulletin cannot be undone: a chunk that reached a block is
 * on the chain and its bytes are spent from the allowance. The next attempt
 * uploads the file again under a new key, and the abandoned chunks are orphans
 * no one holds a key for. Resetting is about this session's state, not the
 * chain's.
 */

import { clearAllowanceLookups } from "./allowance";
import { resetBulletin } from "./client";
import { clearBulletinTransportRecovery } from "./recovery";

export async function resetBulletinSession(): Promise<void> {
  clearAllowanceLookups();
  clearBulletinTransportRecovery();
  // Last: destroying the client can reject in-flight reads, and the caches
  // above should already be clear when those rejections land.
  await resetBulletin();
}
