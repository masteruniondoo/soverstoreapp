/**
 * The one recovery path.
 *
 * A recovery QR, a scanned code, a pasted `Copy Recovery` block and the two
 * manual fields all end here with a CID and a Recovery Key, so there is a
 * single place where a blob is fetched and a single place where it is
 * decrypted. Only the CID is ever sent anywhere; the key stays in this
 * process and is never passed to Bulletin, a host, or a diagnostic line.
 */
import { fetchBlobByCid } from "@/lib/bulletin/retrieve";
import { decryptRecoveryBlob, type RecoveredFile } from "@/lib/recovery/blob";

export type RecoverFileOptions = {
  onProgress?: (message: string) => void;
  /** Retrieval diagnostics. The Recovery Key is never among them. */
  onDiagnostic?: (message: string) => void;
  /** Injected by tests; defaults to the host Bulletin lookup. */
  fetchBlob?: typeof fetchBlobByCid;
};

export async function recoverFile(
  cid: string,
  recoveryKey: string,
  options: RecoverFileOptions = {},
): Promise<RecoveredFile> {
  const fetchBlob = options.fetchBlob ?? fetchBlobByCid;

  options.onProgress?.("Downloading the encrypted file from Bulletin...");
  const blobBytes = await fetchBlob(cid, {
    onDiagnostic: options.onDiagnostic,
  });

  options.onProgress?.("Decrypting locally with your Recovery Key...");
  return decryptRecoveryBlob(blobBytes, recoveryKey);
}
