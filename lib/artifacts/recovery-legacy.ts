/**
 * Readers for the retired recovery JSON, kept so files stored before the
 * Recovery Key change can still be opened.
 *
 * Nothing here writes: SoverStore no longer produces recovery JSON, recovery
 * files, or `#recovery=` links. What it produced before is still valid,
 * because the format only ever wrapped the same 32-byte AES-256-GCM file key
 * this app now hands over directly - `cid` and `key` are lifted out and the
 * rest of the document (blob size, block, extrinsic index) is dropped, since
 * retrieval never needed it.
 *
 * Delete this file and old recovery JSON files stop working; nothing else
 * does.
 */
import {
  normalizeRecoveryDetails,
  type RecoveryDetails,
} from "@/lib/artifacts/recovery";

const LEGACY_FORMAT = "proofbox/recovery@1";

/** Reads a legacy `.recovery.json` document. */
export function parseLegacyRecoveryJson(value: string): RecoveryDetails {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("This is not a SoverStore recovery document.");
  }
  const document = parsed as { format?: unknown; cid?: unknown; key?: unknown };
  if (document?.format !== LEGACY_FORMAT) {
    throw new Error("This is not a SoverStore recovery document.");
  }
  if (typeof document.cid !== "string" || typeof document.key !== "string") {
    throw new Error("This recovery document is missing its CID or key.");
  }
  return normalizeRecoveryDetails({ cid: document.cid, key: document.key });
}

/**
 * Reads a legacy recovery link, which carried the whole JSON document -
 * including the key - URL-encoded in the fragment.
 */
export function parseLegacyRecoveryLink(url: URL): RecoveryDetails | null {
  const document = new URLSearchParams(url.hash.replace(/^#/, "")).get(
    "recovery",
  );
  return document === null ? null : parseLegacyRecoveryJson(document);
}
