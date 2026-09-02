"use client";

import { formatPas, LOW_BALANCE_THRESHOLD } from "@/lib/bulletin/balance";
import { useBulletinBalance } from "@/lib/bulletin/use-bulletin-balance";

// Matches the verified PAS faucet reference already used elsewhere in this
// project for the same account (see CONTEXT.md): Paseo Asset Hub, para 1000.
const FAUCET_URL = "https://faucet.polkadot.io/paseo?parachain=1000";

/**
 * Storage and renewal transactions charge a normal fee, unlike the feeless
 * authorization faucet -- the Product host sponsors that fee from the
 * connected account's balance on Paseo Asset Hub, so that is the balance
 * that needs to be non-zero, not a balance on Bulletin itself.
 */
export function BulletinBalanceNotice({ address }: { address: string | null }) {
  const { balance, checking } = useBulletinBalance(address);
  if (!address) return null;

  const low = balance !== null && balance < LOW_BALANCE_THRESHOLD;

  return (
    <div className={`balance-card${low ? " is-low" : ""}`}>
      <div className="balance-card-row">
        <span className="rail-key">Balance</span>
        <span className="balance-amount">
          {balance === null
            ? checking
              ? "Checking..."
              : "Unknown"
            : formatPas(balance)}
        </span>
        {low && (
          <a
            className="btn btn-pink btn-sm"
            href={FAUCET_URL}
            target="_blank"
            rel="noreferrer"
          >
            Get PAS
          </a>
        )}
      </div>
      {low && (
        <p className="balance-card-note">
          Uploads and renewals need PAS on Paseo Asset Hub to pay their
          transaction fee.
        </p>
      )}
    </div>
  );
}
