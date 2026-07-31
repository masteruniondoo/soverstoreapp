export function randomBytes(size: number): Uint8Array {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("Random byte length must be a non-negative integer.");
  }
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytes;
}
