import { bytesToBase64, base64ToBytes } from "@/lib/crypto/hash";

export type RecoveryV1 = {
  format: "proofbox/recovery@1";
  cid: string;
  key: string;
  blobSize?: number;
  chain?: {
    blockNumber?: number;
    extrinsicIndex?: number;
  };
};

export function buildRecovery(input: {
  cid: string;
  key32: Uint8Array;
  blobSize?: number;
  blockNumber?: number;
  extrinsicIndex?: number;
}): RecoveryV1 {
  if (input.key32.length !== 32) {
    throw new Error("Recovery key must be 32 bytes.");
  }
  const recovery: RecoveryV1 = {
    format: "proofbox/recovery@1",
    cid: input.cid,
    key: bytesToBase64(input.key32),
    blobSize: input.blobSize,
  };
  if (input.blockNumber != null || input.extrinsicIndex != null) {
    recovery.chain = {
      blockNumber: input.blockNumber,
      extrinsicIndex: input.extrinsicIndex,
    };
  }
  return recovery;
}

export function parseRecovery(value: string): RecoveryV1 {
  const parsed = JSON.parse(value);
  if (parsed?.format !== "proofbox/recovery@1") {
    throw new Error("This is not a SoverStore recovery file.");
  }
  if (
    typeof parsed.cid !== "string" ||
    parsed.cid.trim().length === 0 ||
    typeof parsed.key !== "string" ||
    parsed.key.length === 0
  ) {
    throw new Error("Recovery file is missing required fields.");
  }
  if (base64ToBytes(parsed.key).length !== 32) {
    throw new Error("Recovery key must be 32 bytes.");
  }
  if (parsed.blobSize != null && typeof parsed.blobSize !== "number") {
    throw new Error("Recovery blob size must be a number.");
  }
  if (
    parsed.chain != null &&
    (typeof parsed.chain !== "object" ||
      (parsed.chain.blockNumber != null &&
        typeof parsed.chain.blockNumber !== "number") ||
      (parsed.chain.extrinsicIndex != null &&
        typeof parsed.chain.extrinsicIndex !== "number"))
  ) {
    throw new Error("Recovery chain location is invalid.");
  }
  return parsed as RecoveryV1;
}

export function downloadRecovery(fileName: string, recovery: RecoveryV1): void {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(recovery, null, 2)], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${fileName}.recovery.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
