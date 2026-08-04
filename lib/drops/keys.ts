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
export const DROPS_ENCRYPTION_KEYRING_STORAGE_KEY =
  "soverstore.drops.keyring.v2";

export type StoredDropsEncryptionKey = {
  v: 1;
  publicKeyRaw: string;
  privateKeyJwk: JsonWebKey;
  createdAt: string;
};

type StoredDropsEncryptionKeyring = {
  v: 2;
  accounts: Record<string, StoredDropsEncryptionKey[]>;
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

function normalizeAccount(account: string): string {
  const normalized = account.trim().toLowerCase();
  if (!normalized) {
    throw new DropsKeyStorageError("A wallet account is required for Drops key storage.");
  }
  return normalized;
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

function toStoredKey(key: DropsEncryptionKey): StoredDropsEncryptionKey {
  return {
    v: 1,
    publicKeyRaw: bytesToBase64(key.publicKeyRaw),
    privateKeyJwk: key.privateKeyJwk,
    createdAt: key.createdAt,
  };
}

async function loadKeyring(
  store: LocalKvStore,
): Promise<Record<string, DropsEncryptionKey[]>> {
  const stored = await store.getJSON<unknown>(
    DROPS_ENCRYPTION_KEYRING_STORAGE_KEY,
  );
  if (stored === null) return {};
  if (!isRecord(stored) || stored.v !== 2 || !isRecord(stored.accounts)) {
    throw new DropsKeyStorageError("The stored Drops keyring has an unsupported format.");
  }

  const accounts: Record<string, DropsEncryptionKey[]> = {};
  for (const [account, values] of Object.entries(stored.accounts)) {
    if (!Array.isArray(values)) {
      throw new DropsKeyStorageError("The stored Drops keyring is incomplete.");
    }
    const keys = values.map(parseStoredKey);
    const unique = keys.filter((key, index) =>
      keys.findIndex((candidate) =>
        bytesEqual(candidate.publicKeyRaw, key.publicKeyRaw),
      ) === index,
    );
    accounts[normalizeAccount(account)] = unique;
  }
  return accounts;
}

async function saveKeyring(
  store: LocalKvStore,
  accounts: Record<string, DropsEncryptionKey[]>,
): Promise<void> {
  const stored: StoredDropsEncryptionKeyring = {
    v: 2,
    accounts: Object.fromEntries(
      Object.entries(accounts).map(([account, keys]) => [
        normalizeAccount(account),
        keys.map(toStoredKey),
      ]),
    ),
  };
  await store.setJSON(DROPS_ENCRYPTION_KEYRING_STORAGE_KEY, stored);

  // A fresh host-store read catches transient or incompatible storage routes
  // before a purchase is submitted with a key that was not actually retained.
  const verified = await loadKeyring(store);
  for (const [account, keys] of Object.entries(accounts)) {
    const persisted = verified[normalizeAccount(account)] ?? [];
    for (const key of keys) {
      if (!persisted.some((candidate) =>
        bytesEqual(candidate.publicKeyRaw, key.publicKeyRaw),
      )) {
        throw new DropsKeyStorageError(
          "The host did not persist the complete Drops keyring.",
        );
      }
    }
  }
}

async function appendKey(
  store: LocalKvStore,
  account: string,
  key: DropsEncryptionKey,
): Promise<void> {
  const normalized = normalizeAccount(account);
  const accounts = await loadKeyring(store);
  const keys = accounts[normalized] ?? [];
  if (!keys.some((candidate) =>
    bytesEqual(candidate.publicKeyRaw, key.publicKeyRaw),
  )) {
    accounts[normalized] = [...keys, key];
    await saveKeyring(store, accounts);
  }
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
  account: string,
): Promise<DropsEncryptionKey> {
  const generated = await generateDropsEncryptionKeyPair();
  const createdAt = new Date().toISOString();
  const key: DropsEncryptionKey = {
    publicKeyRaw: generated.publicKeyRaw,
    privateKeyJwk: generated.privateKeyJwk,
    createdAt,
  };
  await appendKey(store, account, key);
  return key;
}

export async function loadDropsEncryptionKeyForPublicKey(
  account: string,
  registeredPublicKey: Uint8Array,
  store?: LocalKvStore,
): Promise<DropsEncryptionKey | null> {
  const localStore = await resolveStore(store);
  const normalized = normalizeAccount(account);
  const accounts = await loadKeyring(localStore);
  const matching = (accounts[normalized] ?? []).find((key) =>
    bytesEqual(key.publicKeyRaw, registeredPublicKey),
  );
  if (matching) return matching;

  // v1 stored one global key. Migrate it only after the contract proves which
  // account and purchase it belongs to; never guess when several accounts are used.
  const legacy = await loadDropsEncryptionKey(localStore);
  if (legacy && bytesEqual(legacy.publicKeyRaw, registeredPublicKey)) {
    await appendKey(localStore, normalized, legacy);
    return legacy;
  }
  return null;
}

export async function loadOrCreateDropsEncryptionKey(
  account: string,
  alreadyBuyer: boolean,
  registeredPublicKey?: Uint8Array,
  store?: LocalKvStore,
): Promise<DropsKeyResolution> {
  const localStore = await resolveStore(store);

  if (alreadyBuyer) {
    if (!registeredPublicKey) return { status: "missing-paid-key" };
    const matching = await loadDropsEncryptionKeyForPublicKey(
      account,
      registeredPublicKey,
      localStore,
    );
    return matching
      ? { status: "available", key: matching, created: false }
      : { status: "missing-paid-key" };
  }

  const normalized = normalizeAccount(account);
  const accounts = await loadKeyring(localStore);
  const accountKeys = accounts[normalized] ?? [];
  const existing = accountKeys[accountKeys.length - 1];
  if (existing) return { status: "available", key: existing, created: false };

  // A new account gets its own key. The legacy global key is intentionally not
  // guessed here; it is migrated only when it matches a real on-chain purchase.
  const created = await createAndStoreDropsEncryptionKey(localStore, normalized);
  return { status: "available", key: created, created: true };
}
