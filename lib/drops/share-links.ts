import { buildDropAppLink } from "@/lib/drops/drop-route";

/** The only link copied for a Drop; it is consumed by Polkadot Browse. */
export function getDropAppLink(dropId: string): string {
  return buildDropAppLink(dropId);
}
