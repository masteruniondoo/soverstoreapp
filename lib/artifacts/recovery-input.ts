/**
 * One reader for everything a user can hand the Recover page: a recovery
 * link, the two lines `Copy Recovery` writes, a bare `CID key` pair, or a
 * recovery JSON document left over from before the Recovery Key change.
 *
 * Every entry method - typed, pasted, scanned, or opened from a QR - resolves
 * to the same `RecoveryDetails` here, so there is exactly one place where
 * input becomes a CID and a key, and exactly one recovery path after it.
 */
import {
  parseRecoveryText,
  parseRecoveryUrl,
  type RecoveryDetails,
} from "@/lib/artifacts/recovery";
import {
  parseLegacyRecoveryJson,
  parseLegacyRecoveryLink,
} from "@/lib/artifacts/recovery-legacy";

export function parseRecoveryInput(value: string): RecoveryDetails {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Paste your recovery information first.");

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return parseRecoveryUrl(trimmed);
    } catch (error) {
      const legacy = tryLegacyLink(trimmed);
      if (legacy) return legacy;
      throw error;
    }
  }

  if (trimmed.startsWith("{")) return parseLegacyRecoveryJson(trimmed);

  return parseRecoveryText(trimmed);
}

function tryLegacyLink(value: string): RecoveryDetails | null {
  try {
    return parseLegacyRecoveryLink(new URL(value));
  } catch {
    return null;
  }
}
