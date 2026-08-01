import {
  createLocalKvStore,
  type LocalKvStore,
} from "@parity/product-sdk/local-storage";
import { base64ToBytes, bytesToBase64 } from "@/lib/crypto/hash";
import {
  generateDropsEncryptionKeyPair,
  type DropsEncryptionKeyPair,
} from "@/lib/crypto/wrap";

export const DROPS_ENCRYPTION_KEY_STORAGE_KEY =
  "soverstore.drops.enckey.v1";

export type StoredDropsEncryptionKey = {
  v: 1;
  publicKeyRaw: string;
  privateKeyJwk: JsonWebKey;
  createdAt: string;
};

export type DropsEncryptionKey = DropsEncryptionKeyPair & {
  createdAt: string;
};

export type DropsKeyResolution =
  | { status: "available"; key: DropsEncryptionKey; created: boolean }
  | { status: "missing-paid-key" };

export class DropsKeyStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DropsKeyStorageError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function base64UrlToBytes(value: string): Uint8Array {
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  return base64ToBytes(standard.padEnd(Math.ceil(standard.length / 4) * 4, "="));
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function parseStoredKey(value: unknown): DropsEncryptionKey {
  if (!isRecord(value) || value.v !== 1) {
    throw new DropsKeyStorageError("The stored Drops encryption key has an unsupported format.");
  }
  if (
    typeof value.publicKeyRaw !== "string" ||
    typeof value.createdAt !== "string" ||
    !isRecord(value.privateKeyJwk)
  ) {
    throw new DropsKeyStorageError("The stored Drops encryption key is incomplete.");
  }
  if (Number.isNaN(Date.parse(value.createdAt))) {
    throw new DropsKeyStorageError("The stored Drops encryption key has an invalid creation date.");
  }

  let publicKeyRaw: Uint8Array;
  try {
    publicKeyRaw = base64ToBytes(value.publicKeyRaw);
  } catch {
    throw new DropsKeyStorageError("The stored Drops public key is not valid base64.");
  }
  if (publicKeyRaw.length !== 65 || publicKeyRaw[0] !== 0x04) {
    throw new DropsKeyStorageError("The stored Drops public key is not an uncompressed P-256 key.");
  }

  const privateKeyJwk = value.privateKeyJwk as JsonWebKey;
  if (
    privateKeyJwk.kty !== "EC" ||
    privateKeyJwk.crv !== "P-256" ||
    typeof privateKeyJwk.d !== "string" ||
    typeof privateKeyJwk.x !== "string" ||
    typeof privateKeyJwk.y !== "string"
  ) {
    throw new DropsKeyStorageError("The stored Drops private key is not a P-256 JWK.");
  }

  try {
    const x = base64UrlToBytes(privateKeyJwk.x);
    const y = base64UrlToBytes(privateKeyJwk.y);
    if (
      x.length !== 32 ||
      y.length !== 32 ||
      !bytesEqual(x, publicKeyRaw.slice(1, 33)) ||
      !bytesEqual(y, publicKeyRaw.slice(33))
    ) {
      throw new Error("Public coordinates differ.");
    }
  } catch {
    throw new DropsKeyStorageError("The stored Drops public and private keys do not match.");
  }

  return {
    publicKeyRaw,
    privateKeyJwk,
    createdAt: value.createdAt,
  };
}

async function resolveStore(store?: LocalKvStore): Promise<LocalKvStore> {
  return store ?? createLocalKvStore();
}

export async function loadDropsEncryptionKey(
  store?: LocalKvStore,
): Promise<DropsEncryptionKey | null> {
  const localStore = await resolveStore(store);
  const stored = await localStore.getJSON<unknown>(
    DROPS_ENCRYPTION_KEY_STORAGE_KEY,
  );
  return stored === null ? null : parseStoredKey(stored);
}

async function createAndStoreDropsEncryptionKey(
  store: LocalKvStore,
): Promise<DropsEncryptionKey> {
  const generated = await generateDropsEncryptionKeyPair();
  const createdAt = new Date().toISOString();
  const stored: StoredDropsEncryptionKey = {
    v: 1,
    publicKeyRaw: bytesToBase64(generated.publicKeyRaw),
    privateKeyJwk: generated.privateKeyJwk,
    createdAt,
  };
  await store.setJSON(DROPS_ENCRYPTION_KEY_STORAGE_KEY, stored);

  const readBack = await store.getJSON<unknown>(
    DROPS_ENCRYPTION_KEY_STORAGE_KEY,
  );
  if (readBack === null) {
    throw new DropsKeyStorageError("The host did not persist the Drops encryption key.");
  }
  const verified = parseStoredKey(readBack);
  if (!bytesEqual(verified.publicKeyRaw, generated.publicKeyRaw)) {
    throw new DropsKeyStorageError("The host persisted a different Drops encryption key.");
  }
  return verified;
}

export async function loadOrCreateDropsEncryptionKey(
  alreadyBuyer: boolean,
  store?: LocalKvStore,
): Promise<DropsKeyResolution> {
  const localStore = await resolveStore(store);
  const existing = await loadDropsEncryptionKey(localStore);
  if (existing) return { status: "available", key: existing, created: false };

  // A paid on-chain buyer with no local record has permanently lost this key.
  // Never replace it: the contract envelope was encrypted to the missing key.
  if (alreadyBuyer) return { status: "missing-paid-key" };

  const created = await createAndStoreDropsEncryptionKey(localStore);
  return { status: "available", key: created, created: true };
}
