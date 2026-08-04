import { calculateCid, parseCid } from "@parity/bulletin-sdk";
import { queryBytes } from "@parity/product-sdk/cloud-storage";

const HOST_LOOKUP_TIMEOUT_MS = 30_000;

type FetchHints = {
  blockNumber?: number;
  extrinsicIndex?: number;
  size?: number;
  onDiagnostic?: (message: string) => void;
};

/**
 * Retrieves Bulletin content exclusively through Desktop's host-managed
 * preimage service. The Product never opens an IPFS gateway or Bulletin RPC
 * domain directly, so this path does not request a Remote-site permission.
 * Chunked DAG-PB uploads are reassembled by the Product SDK automatically.
 */
export async function fetchBlobByCid(
  cid: string,
  hints: FetchHints = {},
): Promise<Uint8Array> {
  const parsed = parseCid(cid);
  hints.onDiagnostic?.(
    `Host Bulletin lookup: ${cid} (codec 0x${parsed.code.toString(16)}, expected ${hints.size ?? "unknown"} bytes)`,
  );

  const result = await queryBytes(cid, {
    lookupTimeoutMs: HOST_LOOKUP_TIMEOUT_MS,
  });
  if (!result.ok) throw result.error;

  const bytes = result.value;
  hints.onDiagnostic?.(`Host Bulletin lookup returned ${bytes.length} bytes.`);
  if (hints.size != null && bytes.length !== hints.size) {
    throw new Error(
      `Bulletin size mismatch (expected ${hints.size}, received ${bytes.length}).`,
    );
  }

  // A DAG-PB CID hashes its manifest, not the reassembled response. Raw CIDs
  // can and should be verified against the returned bytes directly.
  if (parsed.code === 0x55) {
    const actual = (await calculateCid(bytes)).toString();
    if (actual !== cid) throw new Error("Bulletin CID verification failed.");
  }
  return bytes;
}
