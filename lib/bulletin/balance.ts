import { getBulletin, resetBulletin } from "./client";
import { DIRECT_QUERY_TIMEOUT_MS, runHostQuery, withHostTimeout } from "./host-query";

/** Paseo/Bulletin native token uses 10 decimals, matching the rest of this app's PAS handling. */
const PAS_UNIT = 10n ** 10n;

/** Below this, a normal store/force_renew fee is at real risk of not being coverable. */
export const LOW_BALANCE_THRESHOLD = PAS_UNIT / 100n; // 0.01 PAS

/**
 * Bulletin's runtime configures `pallet_balances::Config::AccountStore =
 * System` (see runtimes/bulletin-paseo/src/lib.rs upstream): account
 * balances live in `System.Account`, and `Balances.Account` is an unused
 * shim that always reads back the default (zero) value. Reading the wrong
 * one is why this used to show 0 PAS for funded accounts.
 *
 * Guarded with the same host-readiness/timeout/retry treatment as the
 * authorization lookup: querying immediately after a mobile wallet connect,
 * before the host channel handshake has settled, otherwise hangs forever
 * with no error and no result -- this is why the balance could appear to
 * simply never load on the mobile app.
 */
export function fetchBulletinFreeBalance(address: string): Promise<bigint> {
  return runHostQuery(
    async () => {
      const { api } = await withHostTimeout(
        getBulletin(),
        DIRECT_QUERY_TIMEOUT_MS,
        "the Bulletin chain client",
      );
      const account = await withHostTimeout(
        api.query.System.Account.getValue(address) as Promise<{
          data: { free: bigint };
        }>,
        DIRECT_QUERY_TIMEOUT_MS,
        "the account balance",
      );
      return account.data.free;
    },
    resetBulletin,
    "Balance lookup",
  );
}

export function formatPas(value: bigint): string {
  const whole = value / PAS_UNIT;
  const remainder = value % PAS_UNIT;
  if (remainder === 0n) return `${whole} PAS`;
  const fraction = remainder.toString().padStart(10, "0").replace(/0+$/, "");
  return `${whole}.${fraction} PAS`;
}
