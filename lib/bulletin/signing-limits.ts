/**
 * How much of a file may travel inside one signing request.
 *
 * The limit is not Bulletin's - the chain accepts far larger stores - it is
 * whatever carries the signing request from this app to the wallet that
 * answers it, and that differs per host.
 *
 * Measured payloads for `TransactionStorage.store`, encoded against the live
 * runtime (call data is transported as a hex string, so it costs two bytes per
 * raw byte on the wire):
 *
 *     chunk  16 KiB ->  16 390 B call data ->  32 782 hex characters
 *     chunk  32 KiB ->  32 774 B           ->  65 550
 *     chunk  64 KiB ->  65 542 B           -> 131 086
 *     chunk 128 KiB -> 131 078 B           -> 262 158
 *
 * 128 KiB has carried uploads through Polkadot Desktop for as long as this app
 * has existed. On the web gateway, where the request instead reaches a phone
 * paired by QR, the same 128 KiB request reaches the wallet and is approved
 * there, and the signature never comes back: the app waits at "still waiting
 * for mobile wallet approval" until it times out, and the phone hangs too. A
 * file small enough to need no chunking at all - under 32 KB - signs and
 * uploads normally over that same pairing.
 *
 * So the gateway path is given a chunk whose whole request stays inside the
 * only size proven to work there. The exact ceiling is unknown; this sits well
 * below it rather than next to it, because the cost of guessing high is an
 * upload that hangs after the user has already approved it.
 *
 * The price is honest and unavoidable without AutoSigning, which the host
 * reports as unavailable: each chunk is a separate approval on the phone, so a
 * 256 KB file asks for about seventeen of them on the gateway against three in
 * Desktop. Uploading large files from a browser tab is impractical until the
 * transport, or AutoSigning, allows otherwise.
 */

import type { SoverStoreRuntime } from "@/lib/runtime/runtime-classification";

/** Proven in Polkadot Desktop and the mobile app's own WebView. */
export const NATIVE_HOST_CHUNK_SIZE = 128 * 1024;

/** Inside the size proven to sign successfully over a QR-paired phone. */
export const PAIRED_WALLET_CHUNK_SIZE = 16 * 1024;

export type SigningLimits = {
  /** Bytes of file data per store transaction. */
  chunkSize: number;
  /** What actually answers a signing request here, for use in messages: an
   *  error naming Desktop is a false lead when a phone is what went quiet. */
  walletLabel: string;
  /** Hard stop for encoded call data, so an oversized request is refused here
   *  rather than after the user has approved it on the phone. */
  maxCallData: number;
};

/**
 * An unknown runtime is treated like the gateway: it is the conservative
 * choice, and being wrong that way costs extra approvals rather than an
 * upload that cannot complete.
 */
export function signingLimits(runtime: SoverStoreRuntime): SigningLimits {
  const chunkSize =
    runtime === "polkadot-desktop" || runtime === "polkadot-mobile"
      ? NATIVE_HOST_CHUNK_SIZE
      : PAIRED_WALLET_CHUNK_SIZE;

  const walletLabel =
    runtime === "polkadot-desktop"
      ? "Polkadot Desktop"
      : runtime === "polkadot-mobile"
        ? "the Polkadot app"
        : "the Polkadot app paired with this tab";

  // Call data is the chunk plus the call's own preamble and length prefix -
  // 6 bytes at these sizes. A quarter of the chunk is generous room for that
  // without letting a whole extra chunk through.
  return {
    chunkSize,
    walletLabel,
    maxCallData: chunkSize + Math.ceil(chunkSize / 4),
  };
}
