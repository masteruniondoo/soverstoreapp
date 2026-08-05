const UINT256_MAX = (1n << 256n) - 1n;
export const SOVERSTORE_APP_DOMAIN = "soverstore.dot";

export type DropPathResult =
  | { kind: "not-drop" }
  | { kind: "invalid"; reason: string }
  | { kind: "drop"; dropId: string };

export function validateDropId(value: string): string | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  try {
    if (BigInt(value) > UINT256_MAX) return null;
  } catch {
    return null;
  }
  return value;
}

/** Address understood by Browse inside Polkadot Desktop. */
export function buildDropAppLink(dropId: string): string {
  const validated = validateDropId(dropId);
  if (validated === null) throw new Error("A valid Drop ID is required.");
  // Mobile Browse does not reliably preserve the pathname or a hash fragment
  // when a link is pasted directly into its address field, so this format
  // targets Desktop. Mobile users open the Drops page and enter the link (or
  // bare Drop ID) manually into "Open a shared Drop".
  return `${SOVERSTORE_APP_DOMAIN}/drop/${validated}`;
}

export function parseDropAppLink(value: string): DropPathResult {
  const escapedDomain = SOVERSTORE_APP_DOMAIN.replaceAll(".", "\\.");
  const candidate = value
    .trim()
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    // Chat apps that "linkify" this app-only address commonly prepend a
    // www. subdomain and/or append tracking query parameters. Neither is
    // ever meaningful here, so strip them before matching.
    .replace(/^((?:polkadot|https?):\/\/)?www\./i, "$1")
    .replace(/\?[^#]*/, "");
  const match = new RegExp(
    `^(?:(?:polkadot|https?):\\/\\/)?${escapedDomain}(?:/drop/([^/?#]+)/?(?:#/drop/([^/?#]+)/?)?|/?#/drop/([^/?#]+)/?)$`,
    "i",
  ).exec(candidate);
  if (!match) {
    return { kind: "invalid", reason: "The Polkadot app Drop link is malformed." };
  }
  let decodedValues: string[];
  try {
    decodedValues = match.slice(1).filter(Boolean).map(decodeURIComponent);
  } catch {
    return { kind: "invalid", reason: "The Drop ID is malformed." };
  }
  if (new Set(decodedValues).size !== 1) {
    return { kind: "invalid", reason: "The Drop link contains conflicting IDs." };
  }
  const dropId = validateDropId(decodedValues[0]);
  return dropId === null
    ? { kind: "invalid", reason: "The Drop ID is invalid." }
    : { kind: "drop", dropId };
}

/** Resolves the client-only hash route used by mobile-safe Browse links. */
export function parseDropHash(hash: string): DropPathResult {
  if (!hash) return { kind: "not-drop" };
  if (hash !== "#/drop" && !hash.startsWith("#/drop/")) {
    return { kind: "not-drop" };
  }

  const match = /^#\/drop\/([^/?#]+)\/?$/.exec(hash);
  if (!match) {
    return { kind: "invalid", reason: "Expected #/drop/<dropId>." };
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(match[1]);
  } catch {
    return { kind: "invalid", reason: "The Drop ID is malformed." };
  }
  if (decoded.includes("/") || validateDropId(decoded) === null) {
    return { kind: "invalid", reason: "The Drop ID is invalid." };
  }
  return { kind: "drop", dropId: decoded };
}

export function parseDropPathname(pathname: string): DropPathResult {
  if (pathname !== "/drop" && !pathname.startsWith("/drop/")) {
    return { kind: "not-drop" };
  }

  const match = /^\/drop\/([^/]+)\/?$/.exec(pathname);
  if (!match) {
    return { kind: "invalid", reason: "Expected /drop/<dropId>." };
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(match[1]);
  } catch {
    return { kind: "invalid", reason: "The Drop ID is malformed." };
  }
  if (decoded.includes("/") || validateDropId(decoded) === null) {
    return { kind: "invalid", reason: "The Drop ID is invalid." };
  }
  return { kind: "drop", dropId: decoded };
}

export function parseDropUrl(
  value: string,
  expectedOrigin: string,
): DropPathResult {
  let url: URL;
  let origin: URL;
  try {
    url = new URL(value);
    origin = new URL(expectedOrigin);
  } catch {
    return { kind: "invalid", reason: "The Drop URL is malformed." };
  }
  if (url.protocol !== "https:" || url.origin !== origin.origin) {
    return { kind: "invalid", reason: "The Drop URL host is not allowed." };
  }
  if (url.search || url.hash) {
    return { kind: "invalid", reason: "The Drop URL has unsupported data." };
  }
  const parsed = parseDropPathname(url.pathname);
  return parsed.kind === "not-drop"
    ? { kind: "invalid", reason: "The Drop URL path is unsupported." }
    : parsed;
}

/** Accepts either the canonical share URL or a bare on-chain Drop ID. */
export function parseDropEntryValue(
  value: string,
  expectedOrigin: string,
): DropPathResult {
  const candidate = value
    .trim()
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "");
  const dropId = validateDropId(candidate);
  if (dropId !== null) return { kind: "drop", dropId };
  const appLink = parseDropAppLink(candidate);
  if (appLink.kind === "drop") return appLink;
  return parseDropUrl(candidate, expectedOrigin);
}

/**
 * Resolves the app route and recovers it from a trusted gateway referrer when
 * an older native host launches the Product at `/` and drops the deep-link
 * pathname. An unrelated or malformed referrer can never create a route.
 */
export function resolveDropLocation(
  pathname: string,
  referrer: string,
  expectedOrigin: string,
  hash = "",
): DropPathResult {
  const direct = parseDropPathname(pathname);
  if (direct.kind !== "not-drop") {
    return direct;
  }

  const fragmented = parseDropHash(hash);
  if (fragmented.kind !== "not-drop") return fragmented;

  if (pathname !== "/" || !referrer) return direct;

  const referred = parseDropUrl(referrer, expectedOrigin);
  return referred.kind === "drop" ? referred : direct;
}
