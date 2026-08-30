"use client";

import { formatPas, LOW_BALANCE_THRESHOLD } from "@/lib/bulletin/balance";
import { useBulletinBalance } from "@/lib/bulletin/use-bulletin-balance";

const FAUCET_URL = "https://faucet.polkadot.io/paseo?parachain=1010";

/**
 * Storage and renewal transactions charge a normal fee, unlike the feeless
 * authorization faucet -- the connected account needs its own PAS on
 * Products Devnet Bulletin to pay it, or the transaction is rejected before
 * it ever reaches the chain.
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
          Uploads and renewals need PAS on Products Devnet Bulletin to pay
          their transaction fee.
        </p>
      )}
    </div>
  );
}
