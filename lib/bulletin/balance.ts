import { getBulletin } from "./client";

/** Paseo/Bulletin native token uses 10 decimals, matching the rest of this app's PAS handling. */
const PAS_UNIT = 10n ** 10n;

/** Below this, a normal store/force_renew fee is at real risk of not being coverable. */
export const LOW_BALANCE_THRESHOLD = PAS_UNIT / 100n; // 0.01 PAS

export async function fetchBulletinFreeBalance(address: string): Promise<bigint> {
  const { api } = await getBulletin();
  const account = await api.query.Balances.Account.getValue(address);
  return account.free;
}

export function formatPas(value: bigint): string {
  const whole = value / PAS_UNIT;
  const remainder = value % PAS_UNIT;
  if (remainder === 0n) return `${whole} PAS`;
  const fraction = remainder.toString().padStart(10, "0").replace(/0+$/, "");
  return `${whole}.${fraction} PAS`;
}
