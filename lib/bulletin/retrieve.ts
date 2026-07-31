import { calculateCid, parseCid } from "@parity/bulletin-sdk";

export const BULLETIN_IPFS_GATEWAY =
  process.env.NEXT_PUBLIC_BULLETIN_IPFS_GATEWAY ??
  "https://devnet-ipfs.api.polkadotcommunity.foundation";

const FALLBACK_GATEWAYS = [
  "https://bulletin-kubo.tservices.es:9443",
];

const GATEWAY_TIMEOUT_MS = 8_000;

function gatewayUrl(gateway: string, cid: string): string {
  return `${gateway.replace(/\/$/, "")}/ipfs/${cid}`;
}

type FetchHints = {
  blockNumber?: number;
  extrinsicIndex?: number;
  size?: number;
  onDiagnostic?: (message: string) => void;
};

type TransactionIndexEntry = {
  keyArgs: [number];
  value: Array<{
    content_hash?: string;
    size?: number;
    extrinsic_index?: number;
  }>;
};

const PROOFY_MAGIC = new Uint8Array([0x50, 0x52, 0x46, 0x59, 0x31]);

export async function fetchBlobByCid(
  cid: string,
  hints: FetchHints = {},
): Promise<Uint8Array> {
  hints.onDiagnostic?.(
    `Recovery CID: ${cid} (codec 0x${parseCid(cid).code.toString(16)}, expected ${hints.size ?? "unknown"} bytes)`,
  );
  return fetchBlobFromGateways(cid, hints.size, hints.onDiagnostic);
}

async function fetchBlobFromGateways(
  cid: string,
  expectedSize?: number,
  onDiagnostic?: (message: string) => void,
): Promise<Uint8Array> {
  const gateways = [
    BULLETIN_IPFS_GATEWAY,
    ...FALLBACK_GATEWAYS.filter((gateway) => gateway !== BULLETIN_IPFS_GATEWAY),
  ];

  try {
    return await Promise.any(
      gateways.map((gateway) =>
        fetchBlobFromGateway(gateway, cid, expectedSize, onDiagnostic),
      ),
    );
  } catch (e) {
    const errors =
      e instanceof AggregateError
        ? e.errors.map((error) =>
            error instanceof Error ? error.message : String(error),
          )
        : [e instanceof Error ? e.message : "Gateway retrieval failed."];
    throw new Error(
      `Blob not found or gateway unreachable. Tried ${errors.join("; ")}.`,
    );
  }
}

async function fetchBlobFromGateway(
  gateway: string,
  cid: string,
  expectedSize?: number,
  onDiagnostic?: (message: string) => void,
): Promise<Uint8Array> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);
  const url = gatewayUrl(gateway, cid);
  onDiagnostic?.(`GET ${url}`);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
    });
    onDiagnostic?.(
      `${gateway}: HTTP ${response.status}; content-type=${response.headers.get("content-type") ?? "unknown"}; content-length=${response.headers.get("content-length") ?? "unknown"}`,
    );
    if (!response.ok) {
      throw new Error(`${gateway}: HTTP ${response.status}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    onDiagnostic?.(
      `${gateway}: received ${bytes.length} bytes; first64=${bytesToHex(bytes.slice(0, 64))}`,
    );
    if (expectedSize != null && bytes.length !== expectedSize) {
      throw new Error(
        `${gateway}: size mismatch (expected ${expectedSize}, received ${bytes.length})`,
      );
    }

    // A chunked Bulletin upload returns a DAG-PB manifest CID. An IPFS gateway
    // resolves that manifest and returns the reassembled file, whose raw CID is
    // intentionally different from the manifest CID. Only raw CIDs can be
    // compared directly with a hash of the response body.
    if (parseCid(cid).code === 0x55) {
      const actual = (await calculateCid(bytes)).toString();
      if (actual !== cid) {
        throw new Error(`${gateway}: CID mismatch`);
      }
    }
    return bytes;
  } catch (e) {
    const message =
      e instanceof DOMException && e.name === "AbortError"
        ? `timed out after ${GATEWAY_TIMEOUT_MS / 1000}s`
        : e instanceof Error
          ? e.message
          : "network error";
    throw new Error(`${gateway}: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchBlobFromChain(
  cid: string,
  hints: FetchHints,
): Promise<Uint8Array> {
  const location =
    hints.blockNumber != null &&
    hints.extrinsicIndex != null &&
    hints.size != null
      ? {
          blockNumber: hints.blockNumber,
          extrinsicIndex: hints.extrinsicIndex,
          size: hints.size,
        }
      : await findTransactionByCid(cid);

  const { getBulletin } = await import("./client");
  const { client } = await getBulletin();
  const request = client as unknown as {
    _request: (method: string, params: unknown[]) => Promise<unknown>;
  };
  const blockHash = await request._request("chain_getBlockHash", [
    location.blockNumber,
  ]);
  if (typeof blockHash !== "string") {
    throw new Error("Could not resolve Bulletin block hash.");
  }

  const blockResponse = (await request._request("chain_getBlock", [
    blockHash,
  ])) as {
    block?: { extrinsics?: string[] };
  };
  const extrinsics = blockResponse.block?.extrinsics ?? null;
  if (!extrinsics?.length) {
    throw new Error("Stored extrinsic was not found in the Bulletin block.");
  }

  const preferred = extrinsics[location.extrinsicIndex];
  if (preferred) {
    const blob = await extractBlobFromExtrinsic(preferred, cid, location.size);
    if (blob) return blob;
  }

  for (const extrinsic of extrinsics) {
    const blob = await extractBlobFromExtrinsic(extrinsic, cid, location.size);
    if (blob) return blob;
  }

  throw new Error(
    "Stored Bulletin block does not contain the requested SoverStore blob.",
  );
}

async function extractBlobFromExtrinsic(
  extrinsic: string,
  cid: string,
  size: number,
): Promise<Uint8Array | null> {
  const extrinsicBytes = hexToBytes(extrinsic);
  const starts = findAllMagic(extrinsicBytes);
  for (const start of starts) {
    const end = start + size;
    if (end > extrinsicBytes.length) continue;
    const blob = extrinsicBytes.slice(start, end);
    const actual = (await calculateCid(blob)).toString();
    if (actual === cid) return blob;
  }
  return null;
}

async function findTransactionByCid(cid: string): Promise<{
  blockNumber: number;
  extrinsicIndex: number;
  size: number;
}> {
  const digest = bytesToHex(new Uint8Array(parseCid(cid).multihash.digest));
  const { getBulletin } = await import("./client");
  const { api } = await getBulletin();
  const entries =
    (await api.query.TransactionStorage.Transactions.getEntries()) as TransactionIndexEntry[];

  for (const entry of entries) {
    for (const tx of entry.value) {
      if ((tx.content_hash ?? "").replace(/^0x/, "") !== digest) continue;
      if (tx.extrinsic_index == null || tx.size == null) {
        throw new Error("Bulletin transaction index is missing blob location.");
      }
      return {
        blockNumber: Number(entry.keyArgs[0]),
        extrinsicIndex: Number(tx.extrinsic_index),
        size: Number(tx.size),
      };
    }
  }

  throw new Error("CID was not found in the Bulletin transaction index.");
}

function findAllMagic(bytes: Uint8Array): number[] {
  const offsets: number[] = [];
  for (let offset = 0; offset <= bytes.length - PROOFY_MAGIC.length; offset += 1) {
    let matches = true;
    for (let i = 0; i < PROOFY_MAGIC.length; i += 1) {
      if (bytes[offset + i] !== PROOFY_MAGIC[i]) {
        matches = false;
        break;
      }
    }
    if (matches) offsets.push(offset);
  }
  return offsets;
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
