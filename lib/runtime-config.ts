export const BULLETIN_NETWORK_NAME =
  process.env.NEXT_PUBLIC_BULLETIN_NETWORK_NAME ??
  "Products Devnet Bulletin";

export const BULLETIN_NETWORK_ID =
  process.env.NEXT_PUBLIC_BULLETIN_NETWORK_ID ??
  "devnet-bulletin";

export const APP_ORIGIN =
  process.env.NEXT_PUBLIC_APP_ORIGIN ??
  "https://soverstore.dev-dot.li";

/** Web gateway origin used only to classify and validate browser/referrer input. */
export const DROP_SHARE_ORIGIN =
  process.env.NEXT_PUBLIC_DROP_ORIGIN ?? APP_ORIGIN;
