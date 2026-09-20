/**
 * The Recovery Key: the single secret that turns a public blob back into the
 * original file.
 *
 * `PBX1 blob + Recovery Key = original file`. The blob is public - anyone may
 * download it from Bulletin - and the key is the only thing standing between
 * that blob and the plaintext. It is generated in the browser, used directly
 * as the AES-256-GCM file key, and handed to the user. SoverStore never
 * uploads it, stores it, or writes it to a log.
 *
 * Nothing here may import a browser-only module: the same parsing runs under
 * `node --test`.
 */
import { base64ToBytes, bytesToBase64 } from "@/lib/crypto/hash";
import { randomBytes } from "@/lib/crypto/random";
import { APP_ORIGIN } from "@/lib/runtime-config";

/** 256 bits, the AES-256-GCM key length. */
export const RECOVERY_KEY_BYTES = 32;

/** The route a recovery link opens. */
export const RECOVERY_ROUTE = "/recovery/";

/**
 * Read by the Polkadot host shell, not by this app - which is why it looks
 * unused from in here, and why removing it once cost a release.
 *
 * By default the host resolves a dotNS domain to its content through a light
 * client running in the browser, which has to sync before it can answer and
 * keeps its synced view in local storage. A view that lags, or one left over
 * from before a deploy, resolves the previous bundle: the app opens, looks
 * fine, and is the old version. `rpc-gateway` asks trusted RPC servers for
 * current chain state instead.
 *
 * A recovery link is exactly where that must not happen. It is opened rarely,
 * often on a device that has never loaded this app, by someone who needs their
 * file now.
 */
const HOST_CHAIN_BACKEND = "rpc-gateway";

/** The labels `Copy Recovery` writes, and the Recover page reads back. */
export const CID_LABEL = "CID";
export const RECOVERY_KEY_LABEL = "Recovery Key";

/** Everything needed to recover one file. The key is never sent anywhere. */
export type RecoveryDetails = {
  cid: string;
  /** The 256-bit key, Base64URL without padding. */
  key: string;
};

/** A fresh 256-bit key. One per file, never derived from anything. */
export function generateRecoveryKey(): Uint8Array {
  return randomBytes(RECOVERY_KEY_BYTES);
}

/**
 * Base64URL without padding, so the key survives a URL fragment, a QR code,
 * and a double-click selection without escaping or truncation.
 */
export function encodeRecoveryKey(key32: Uint8Array): string {
  if (key32.length !== RECOVERY_KEY_BYTES) {
    throw new Error("A Recovery Key must be 32 bytes (256 bits).");
  }
  return bytesToBase64(key32)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Accepts the canonical Base64URL form and, because a 32-byte key is a
 * 32-byte key however it was written down, standard Base64 with or without
 * padding - which is what the retired recovery JSON stored.
 */
export function decodeRecoveryKey(value: string): Uint8Array {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("A Recovery Key is required.");
  const standard = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  const padded = standard + "=".repeat((4 - (standard.length % 4)) % 4);

  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(padded);
  } catch {
    throw new Error("This Recovery Key is not valid Base64URL text.");
  }
  if (bytes.length !== RECOVERY_KEY_BYTES) {
    throw new Error("A Recovery Key must be 32 bytes (256 bits).");
  }
  return bytes;
}

/**
 * Checks a CID/key pair and rewrites the key in canonical Base64URL, so a key
 * typed in an older encoding is still shown and stored one way.
 */
export function normalizeRecoveryDetails(
  details: RecoveryDetails,
): RecoveryDetails {
  const cid = details.cid.trim();
  if (!cid) throw new Error("A Bulletin CID is required.");
  if (!/^[A-Za-z0-9]+$/.test(cid)) {
    throw new Error("This does not look like a Bulletin CID.");
  }
  return { cid, key: encodeRecoveryKey(decodeRecoveryKey(details.key)) };
}

/**
 * What `Copy Recovery` puts on the clipboard. Two labelled lines: readable
 * enough to paste into a password manager, regular enough for
 * `parseRecoveryText` to read straight back.
 */
export function formatRecoveryText(details: RecoveryDetails): string {
  const normalized = normalizeRecoveryDetails(details);
  return (
    `${CID_LABEL}: ${normalized.cid}\n` +
    `${RECOVERY_KEY_LABEL}: ${normalized.key}`
  );
}

const CID_LINE = /^\s*(?:bulletin\s+)?cid\s*[:=]\s*(\S+)\s*$/i;
const KEY_LINE = /^\s*(?:recovery[\s_-]*)?key\s*[:=]\s*(\S+)\s*$/i;

/**
 * Reads back what `Copy Recovery` wrote, and tolerates the shapes a person
 * actually pastes: the two labelled lines in either order, extra lines around
 * them, or just the CID and the key separated by whitespace.
 */
export function parseRecoveryText(value: string): RecoveryDetails {
  let cid: string | null = null;
  let key: string | null = null;

  for (const line of value.split(/\r?\n/)) {
    const cidMatch = CID_LINE.exec(line);
    if (cidMatch) {
      cid = cidMatch[1];
      continue;
    }
    const keyMatch = KEY_LINE.exec(line);
    if (keyMatch) key = keyMatch[1];
  }

  if (cid === null && key === null) {
    const tokens = value.trim().split(/\s+/);
    if (tokens.length === 2) [cid, key] = tokens;
  }

  if (!cid || !key) {
    throw new Error(
      `Paste both lines produced by Copy Recovery ("${CID_LABEL}: ..." and "${RECOVERY_KEY_LABEL}: ...").`,
    );
  }
  return normalizeRecoveryDetails({ cid, key });
}

/** The origin recovery links are built against. */
export function recoveryAppOrigin(): string {
  if (APP_ORIGIN) return APP_ORIGIN.replace(/\/$/, "");
  if (typeof window !== "undefined") return window.location.origin;
  throw new Error("The SoverStore application origin is not configured.");
}

/**
 * The link a recovery QR carries.
 *
 * The CID is a query parameter; the Recovery Key is in the fragment, and only
 * in the fragment. A fragment is never put on the wire by the browser, so the
 * key stays out of request logs, proxy logs, and referrer headers on the way
 * to the page that needs it. Anything that moves the key into the query
 * string turns a local secret into a logged one.
 */
export function recoveryUrl(
  details: RecoveryDetails,
  origin: string = recoveryAppOrigin(),
): string {
  const { cid, key } = normalizeRecoveryDetails(details);
  const query = new URLSearchParams({ cid, chainBackend: HOST_CHAIN_BACKEND });
  return `${origin.replace(/\/$/, "")}${RECOVERY_ROUTE}?${query}#key=${encodeURIComponent(key)}`;
}

/**
 * Reads a recovery link back. The key is only ever taken from the fragment:
 * a link carrying it in the query string has already leaked it, and is not a
 * link this app produces.
 */
export function parseRecoveryUrl(value: string): RecoveryDetails {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("This is not a SoverStore recovery link.");
  }
  const cid = url.searchParams.get("cid");
  const key = new URLSearchParams(url.hash.replace(/^#/, "")).get("key");
  if (!cid || !key) {
    throw new Error("This recovery link is missing its CID or Recovery Key.");
  }
  return normalizeRecoveryDetails({ cid, key });
}

/** The paths a recovery link may land on; see `parseRecoveryUrl`. */
export function isRecoveryRoutePath(pathname: string): boolean {
  return ["/", "/preview", "/preview/", "/recovery", "/recovery/"].includes(
    pathname,
  );
}
