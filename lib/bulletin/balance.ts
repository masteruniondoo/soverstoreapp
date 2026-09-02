import { getAssetHubBalance } from "@/lib/drops/contract";

/** Paseo native token uses 10 decimals. */
const PAS_UNIT = 10n ** 10n;

/** Below this, a normal store/force_renew fee is at real risk of not being coverable. */
export const LOW_BALANCE_THRESHOLD = PAS_UNIT / 100n; // 0.01 PAS

/**
 * Bulletin transactions are fee-sponsored through the Product host from the
 * connected account's balance on Paseo Asset Hub, not a balance on the
 * Bulletin chain itself -- Bulletin's own native balance is never charged
 * and does not need to hold anything. Reuses the same
 * `getChainAPI("devnet").assetHub` connection Drops already relies on for
 * its own balance checks.
 */
export async function fetchFeePayerBalance(address: string): Promise<bigint> {
  const balance = await getAssetHubBalance(address);
  return balance.spendable;
}

export function formatPas(value: bigint): string {
  const whole = value / PAS_UNIT;
  const remainder = value % PAS_UNIT;
  if (remainder === 0n) return `${whole} PAS`;
  const fraction = remainder.toString().padStart(10, "0").replace(/0+$/, "");
  return `${whole}.${fraction} PAS`;
}
