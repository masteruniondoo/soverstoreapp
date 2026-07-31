export class WrongKeyOrCorrupted extends Error {
  constructor() {
    super("Wrong key for this CID, or the blob is corrupted.");
    this.name = "WrongKeyOrCorrupted";
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

async function importAesKey(key32: Uint8Array): Promise<CryptoKey> {
  if (key32.length !== 32) {
    throw new Error("AES-256-GCM key must be 32 bytes.");
  }
  return crypto.subtle.importKey("raw", toArrayBuffer(key32), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function aesGcmEncrypt(
  key32: Uint8Array,
  iv12: Uint8Array,
  plain: Uint8Array,
): Promise<Uint8Array> {
  if (iv12.length !== 12) throw new Error("AES-GCM IV must be 12 bytes.");
  const key = await importAesKey(key32);
  return new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv12) },
      key,
      toArrayBuffer(plain),
    ),
  );
}

export async function aesGcmDecrypt(
  key32: Uint8Array,
  iv12: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  if (iv12.length !== 12) throw new Error("AES-GCM IV must be 12 bytes.");
  try {
    const key = await importAesKey(key32);
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: toArrayBuffer(iv12) },
        key,
        toArrayBuffer(ciphertext),
      ),
    );
  } catch {
    throw new WrongKeyOrCorrupted();
  }
}
