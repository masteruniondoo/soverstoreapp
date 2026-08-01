import { randomBytes } from "./random";

const PUBLIC_KEY_BYTES = 65;
const IV_BYTES = 12;
const CONTENT_KEY_BYTES = 32;
const CIPHERTEXT_BYTES = CONTENT_KEY_BYTES + 16;
const INFO_PREFIX = "soverstore/drops/v1|drop=";

export const DROP_ENVELOPE_BYTES =
  PUBLIC_KEY_BYTES + IV_BYTES + CIPHERTEXT_BYTES;

export type DropsEncryptionKeyPair = {
  publicKeyRaw: Uint8Array;
  privateKeyJwk: JsonWebKey;
};

export class DropEnvelopeDecryptError extends Error {
  constructor() {
    super("This envelope cannot be opened with this device key.");
    this.name = "DropEnvelopeDecryptError";
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const combined = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.length;
  }
  return combined;
}

function requireDropId(dropId: bigint): void {
  if (dropId < 1n) throw new Error("Drop id must be at least 1.");
}

function requirePublicKey(publicKeyRaw: Uint8Array): void {
  if (publicKeyRaw.length !== PUBLIC_KEY_BYTES || publicKeyRaw[0] !== 0x04) {
    throw new Error("P-256 public key must be 65-byte uncompressed form.");
  }
}

async function importPublicKey(publicKeyRaw: Uint8Array): Promise<CryptoKey> {
  requirePublicKey(publicKeyRaw);
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(publicKeyRaw),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
}

async function deriveKek(
  privateKey: CryptoKey,
  peerPublicKey: CryptoKey,
  salt: Uint8Array,
  dropId: bigint,
): Promise<CryptoKey> {
  const shared = await crypto.subtle.deriveBits(
    { name: "ECDH", public: peerPublicKey },
    privateKey,
    256,
  );
  const ikm = await crypto.subtle.importKey("raw", shared, "HKDF", false, [
    "deriveKey",
  ]);
  const info = new TextEncoder().encode(`${INFO_PREFIX}${dropId}`);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toArrayBuffer(salt),
      info: toArrayBuffer(info),
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function generateContentKey(): Uint8Array {
  return randomBytes(CONTENT_KEY_BYTES);
}

export async function generateDropsEncryptionKeyPair(): Promise<DropsEncryptionKeyPair> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const publicKeyRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", keyPair.publicKey),
  );
  requirePublicKey(publicKeyRaw);
  return {
    publicKeyRaw,
    privateKeyJwk: await crypto.subtle.exportKey("jwk", keyPair.privateKey),
  };
}

export async function wrapContentKey(
  contentKey: Uint8Array,
  buyerPublicKeyRaw: Uint8Array,
  dropId: bigint,
): Promise<Uint8Array> {
  if (contentKey.length !== CONTENT_KEY_BYTES) {
    throw new Error("Drop content key must be 32 bytes.");
  }
  requireDropId(dropId);
  const buyerPublicKey = await importPublicKey(buyerPublicKeyRaw);
  const ephemeral = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const ephemeralPublicRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", ephemeral.publicKey),
  );
  const salt = concatBytes(ephemeralPublicRaw, buyerPublicKeyRaw);
  const kek = await deriveKek(
    ephemeral.privateKey,
    buyerPublicKey,
    salt,
    dropId,
  );
  const iv = randomBytes(IV_BYTES);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      kek,
      toArrayBuffer(contentKey),
    ),
  );
  if (ciphertext.length !== CIPHERTEXT_BYTES) {
    throw new Error("Unexpected AES-GCM envelope ciphertext length.");
  }
  return concatBytes(ephemeralPublicRaw, iv, ciphertext);
}

export async function unwrapContentKey(
  envelope: Uint8Array,
  buyerPublicKeyRaw: Uint8Array,
  buyerPrivateKeyJwk: JsonWebKey,
  dropId: bigint,
): Promise<Uint8Array> {
  try {
    requireDropId(dropId);
    requirePublicKey(buyerPublicKeyRaw);
    if (envelope.length !== DROP_ENVELOPE_BYTES) {
      throw new Error("Invalid envelope length.");
    }
    const ephemeralPublicRaw = envelope.slice(0, PUBLIC_KEY_BYTES);
    const iv = envelope.slice(PUBLIC_KEY_BYTES, PUBLIC_KEY_BYTES + IV_BYTES);
    const ciphertext = envelope.slice(PUBLIC_KEY_BYTES + IV_BYTES);
    const ephemeralPublicKey = await importPublicKey(ephemeralPublicRaw);
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      buyerPrivateKeyJwk,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
    const salt = concatBytes(ephemeralPublicRaw, buyerPublicKeyRaw);
    const kek = await deriveKek(
      privateKey,
      ephemeralPublicKey,
      salt,
      dropId,
    );
    const contentKey = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: toArrayBuffer(iv) },
        kek,
        toArrayBuffer(ciphertext),
      ),
    );
    if (contentKey.length !== CONTENT_KEY_BYTES) {
      throw new Error("Invalid content key length.");
    }
    return contentKey;
  } catch (error) {
    if (error instanceof DropEnvelopeDecryptError) throw error;
    throw new DropEnvelopeDecryptError();
  }
}
