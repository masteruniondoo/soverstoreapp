import { bytesToBase64 } from "@/lib/crypto/hash";

const MAGIC = "PRFY1";
const MAGIC_BYTES = new TextEncoder().encode(MAGIC);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type ProofyBlobHeaderV1 = {
  v: 1;
  alg: "AES-256-GCM";
  iv: string;
  commitment?: string;
};

export type ProofyInnerMeta = {
  name: string;
  type: string;
  size: number;
  sha256?: string;
  createdAt: string;
};

export function buildHeader(iv12: Uint8Array): ProofyBlobHeaderV1 {
  if (iv12.length !== 12) throw new Error("Blob IV must be 12 bytes.");
  return {
    v: 1,
    alg: "AES-256-GCM",
    iv: bytesToBase64(iv12),
  };
}

export function encodeBlob(
  header: ProofyBlobHeaderV1,
  ciphertext: Uint8Array,
): Uint8Array {
  validateHeader(header);
  const headerBytes = textEncoder.encode(JSON.stringify(header));
  const output = new Uint8Array(9 + headerBytes.length + ciphertext.length);
  output.set(MAGIC_BYTES, 0);
  new DataView(output.buffer).setUint32(5, headerBytes.length, true);
  output.set(headerBytes, 9);
  output.set(ciphertext, 9 + headerBytes.length);
  return output;
}

export function decodeBlob(bytes: Uint8Array): {
  header: ProofyBlobHeaderV1;
  ciphertext: Uint8Array;
} {
  if (bytes.length < 9) throw new Error("Blob is too small.");
  for (let i = 0; i < MAGIC_BYTES.length; i += 1) {
    if (bytes[i] !== MAGIC_BYTES[i]) {
      throw new Error("Not a SoverStore encrypted blob.");
    }
  }
  const headerLen = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(5, true);
  const headerEnd = 9 + headerLen;
  if (headerEnd > bytes.length) throw new Error("Blob header is truncated.");
  const parsed = JSON.parse(textDecoder.decode(bytes.slice(9, headerEnd)));
  validateHeader(parsed);
  return {
    header: parsed,
    ciphertext: bytes.slice(headerEnd),
  };
}

export function encodeInner(meta: ProofyInnerMeta, content: Uint8Array): Uint8Array {
  validateMeta(meta);
  const metaBytes = textEncoder.encode(JSON.stringify(meta));
  const output = new Uint8Array(4 + metaBytes.length + content.length);
  new DataView(output.buffer).setUint32(0, metaBytes.length, true);
  output.set(metaBytes, 4);
  output.set(content, 4 + metaBytes.length);
  return output;
}

export function decodeInner(bytes: Uint8Array): {
  meta: ProofyInnerMeta;
  content: Uint8Array;
} {
  if (bytes.length < 4) throw new Error("Inner payload is too small.");
  const metaLen = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(0, true);
  const metaEnd = 4 + metaLen;
  if (metaEnd > bytes.length) throw new Error("Inner metadata is truncated.");
  const parsed = JSON.parse(textDecoder.decode(bytes.slice(4, metaEnd)));
  validateMeta(parsed);
  return {
    meta: parsed,
    content: bytes.slice(metaEnd),
  };
}

export function estimateBlobSize(file: {
  name: string;
  type: string;
  size: number;
}): number {
  const dummyMeta: ProofyInnerMeta = {
    name: file.name,
    type: file.type,
    size: file.size,
    createdAt: new Date().toISOString(),
  };
  const dummyHeader = buildHeader(new Uint8Array(12));
  const headerLen = textEncoder.encode(JSON.stringify(dummyHeader)).length;
  const metaLen = textEncoder.encode(JSON.stringify(dummyMeta)).length;
  return 9 + headerLen + 4 + metaLen + file.size + 16;
}

function validateHeader(value: unknown): asserts value is ProofyBlobHeaderV1 {
  const header = value as Partial<ProofyBlobHeaderV1>;
  if (header.v !== 1) {
    throw new Error("Blob was created by a newer SoverStore version.");
  }
  if (header.alg !== "AES-256-GCM") {
    throw new Error("Unsupported blob encryption algorithm.");
  }
  if (typeof header.iv !== "string") {
    throw new Error("Blob header is missing required fields.");
  }
}

function validateMeta(value: unknown): asserts value is ProofyInnerMeta {
  const meta = value as Partial<ProofyInnerMeta>;
  if (
    typeof meta.name !== "string" ||
    typeof meta.type !== "string" ||
    typeof meta.size !== "number" ||
    typeof meta.createdAt !== "string"
  ) {
    throw new Error("Inner metadata is missing required fields.");
  }
}
