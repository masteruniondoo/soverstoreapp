/**
 * The two halves of `PBX1 + Recovery Key = original file`, side by side so
 * they cannot drift apart.
 *
 * The blob format is unchanged: a PBX1 header carrying the version, the
 * algorithm, and the nonce, followed by the AES-256-GCM ciphertext with its
 * tag. Everything in it is public and everything decryption needs beyond it
 * is the Recovery Key, which is the file key itself - there is no second key
 * layer and nothing else to keep.
 */
import {
  buildHeader,
  decodeBlob,
  decodeInner,
  encodeBlob,
  encodeInner,
  type ProofyInnerMeta,
} from "@/lib/blob/format";
import { decodeRecoveryKey } from "@/lib/artifacts/recovery";
import { aesGcmDecrypt, aesGcmEncrypt } from "@/lib/crypto/aes";
import { base64ToBytes } from "@/lib/crypto/hash";
import { randomBytes } from "@/lib/crypto/random";

export type RecoveredFile = {
  meta: ProofyInnerMeta;
  content: Uint8Array;
};

/**
 * Encrypts one file under its own Recovery Key. The key is passed in rather
 * than generated here so the caller keeps the only copy and decides what
 * happens to it.
 */
export async function encryptFileToBlob(input: {
  key32: Uint8Array;
  bytes: Uint8Array;
  name: string;
  type: string;
  size: number;
  createdAt?: string;
}): Promise<Uint8Array> {
  const iv = randomBytes(12);
  const meta: ProofyInnerMeta = {
    name: input.name,
    type: input.type || "application/octet-stream",
    size: input.size,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  const ciphertext = await aesGcmEncrypt(
    input.key32,
    iv,
    encodeInner(meta, input.bytes),
  );
  return encodeBlob(buildHeader(iv), ciphertext);
}

/**
 * Decrypts a PBX1 blob with a Recovery Key. A wrong key and a tampered blob
 * both fail the same way - AES-GCM authenticates before it returns anything -
 * and surface as `WrongKeyOrCorrupted`.
 */
export async function decryptRecoveryBlob(
  blobBytes: Uint8Array,
  recoveryKey: string,
): Promise<RecoveredFile> {
  const key32 = decodeRecoveryKey(recoveryKey);
  const decoded = decodeBlob(blobBytes);
  const plain = await aesGcmDecrypt(
    key32,
    base64ToBytes(decoded.header.iv),
    decoded.ciphertext,
  );
  return decodeInner(plain);
}
