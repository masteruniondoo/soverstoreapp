"use client";

import { useCallback, useState } from "react";
import { BulletinError } from "@parity/bulletin-sdk";
import { AddressRow } from "@/components/AddressRow";
import { useAppSession } from "@/components/AppSessionProvider";
import { BulletinBalanceNotice } from "@/components/BulletinBalanceNotice";
import { Nav } from "@/components/Nav";
import {
  ensureAccountBulletinReady,
  useUploadHistory,
  type FileRecord,
} from "@/lib/bulletin";
import { recoverTimedOutBulletinTransport } from "@/lib/bulletin/recovery";
import { formatBytes, formatNumber } from "@/lib/format";
import { BULLETIN_NETWORK_NAME } from "@/lib/runtime-config";

type RenewState =
  | { status: "idle" }
  | { status: "working"; message: string }
  | { status: "error"; message: string }
  | { status: "done"; message: string };

function statusLabel(status: FileRecord["status"]): string {
  switch (status) {
    case "active":
      return "Active";
    case "expiring-soon":
      return "Expiring soon";
    case "expired":
      return "Expired";
    default:
      return "Checking...";
  }
}

function statusClass(status: FileRecord["status"]): string {
  switch (status) {
    case "active":
      return "sale";
    case "expiring-soon":
      return "warning";
    case "expired":
      return "expired";
    default:
      return "";
  }
}

export default function MyFilesPage() {
  const {
    selectedAccount,
    selectedAddress,
    connectWallet: connectSessionWallet,
    bulletinAllowance: allowance,
    checkingBulletinAllowance: checkingAllowance,
    setKnownBulletinAllowance,
  } = useAppSession();

  const { records, loadingChainInfo, chainInfoError, refreshChainInfo, renew } =
    useUploadHistory(selectedAddress);

  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [renewState, setRenewState] = useState<Record<string, RenewState>>({});

  const walletConnected = selectedAddress != null;
  const authorized = allowance?.usable === true;

  const connect = useCallback(async () => {
    setConnecting(true);
    setConnectError(null);
    try {
      const connected = await connectSessionWallet();
      const next = await ensureAccountBulletinReady(
        connected.address,
        () => undefined,
      );
      setKnownBulletinAllowance(connected.address, next);
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : String(error));
    } finally {
      setConnecting(false);
    }
  }, [connectSessionWallet, setKnownBulletinAllowance]);

  const renewFile = useCallback(
    async (record: FileRecord) => {
      if (!selectedAccount) return;
      const setThis = (state: RenewState) =>
        setRenewState((current) => ({ ...current, [record.cid]: state }));

      setThis({ status: "working", message: "Checking Bulletin authorization..." });
      try {
        const authorization = await ensureAccountBulletinReady(
          selectedAccount.address,
          (message) => setThis({ status: "working", message }),
        );
        setKnownBulletinAllowance(selectedAccount.address, authorization);
        await renew(record, selectedAccount.polkadotSigner, (message) =>
          setThis({ status: "working", message }),
        );
        setThis({
          status: "done",
          message: "Renewed. The retention period has been extended.",
        });
      } catch (error) {
        if (recoverTimedOutBulletinTransport(selectedAccount.address, error)) {
          return;
        }
        setThis({
          status: "error",
          message:
            error instanceof BulletinError
              ? `${error.message} - ${error.recoveryHint}`
              : error instanceof Error
                ? error.message
                : String(error),
        });
      }
    },
    [selectedAccount, renew, setKnownBulletinAllowance],
  );

  return (
    <main className="shell drops-page">
      <Nav />
      <header className="masthead masthead-network">
        <div className="net-chip">{BULLETIN_NETWORK_NAME}</div>
      </header>

      <h1 className="app-title">Files you have uploaded from this browser.</h1>

      {!walletConnected ? (
        <section className="drops-owner-panel">
          <h2>Connect to see your files</h2>
          <p>
            SoverStore remembers uploads locally in this browser. Connect the
            same wallet you used to upload to see them here and renew their
            storage before it expires.
          </p>
          <div className="actions-row">
            <button
              className="btn btn-pink"
              type="button"
              onClick={() => void connect()}
              disabled={connecting}
            >
              {connecting ? "Connecting..." : "Connect"}
            </button>
          </div>
          {connectError && <p className="error">{connectError}</p>}
        </section>
      ) : (
        <>
          <section className="rail" aria-label="Connection status">
            <div className="rail-row">
              <span className="dot on" />
              <span className="rail-key">Wallet</span>
              <span className="rail-val">
                Connected
                {selectedAccount?.name && (
                  <span className="wallet-account-name">
                    {selectedAccount.name}
                  </span>
                )}
              </span>
            </div>
            {selectedAddress && <AddressRow address={selectedAddress} />}
            <div className="rail-row">
              <span className={`dot ${authorized ? "on" : ""}`} />
              <span className="rail-key">Bulletin</span>
              <span className="rail-val">
                {checkingAllowance
                  ? "Checking authorization..."
                  : authorized
                    ? "Authorized"
                    : "No active authorization"}
              </span>
            </div>
          </section>
          <BulletinBalanceNotice address={selectedAddress} />

          {records.length === 0 ? (
            <p className="drops-empty">
              No uploads recorded yet in this browser. Files you upload from
              Storage will appear here.
            </p>
          ) : (
            <section className="drops-list">
              <div className="drops-list-heading">
                <span>{records.length} file(s) in this browser</span>
                <button
                  className="btn btn-ink"
                  type="button"
                  onClick={() => void refreshChainInfo()}
                  disabled={loadingChainInfo}
                >
                  {loadingChainInfo ? "Checking..." : "Recheck expiration"}
                </button>
              </div>
              {chainInfoError && <p className="error">{chainInfoError}</p>}
              {records.map((record) => {
                const state = renewState[record.cid] ?? { status: "idle" as const };
                return (
                  <article className="drops-card" key={record.cid}>
                    <div className="drops-card-topline">
                      <span>{new Date(record.timestamp).toLocaleString()}</span>
                      <span className={`drops-state ${statusClass(record.status)}`}>
                        {statusLabel(record.status)}
                      </span>
                    </div>
                    <h2>{record.fileName}</h2>
                    <dl className="drops-facts">
                      <div>
                        <dt>CID</dt>
                        <dd className="files-cid-value">{record.cid}</dd>
                      </div>
                      <div>
                        <dt>Size</dt>
                        <dd>{formatBytes(BigInt(record.size))}</dd>
                      </div>
                      <div>
                        <dt>Uploaded at block</dt>
                        <dd>#{formatNumber(record.blockNumber)}</dd>
                      </div>
                      <div>
                        <dt>Expires at block</dt>
                        <dd>
                          {record.expiresAtBlock === null
                            ? "-"
                            : `#${formatNumber(record.expiresAtBlock)}`}
                        </dd>
                      </div>
                    </dl>
                    {record.percentRemaining !== null && record.blocksRemaining !== null && (
                      <div className="files-lease">
                        <div className="files-lease-bar">
                          <div
                            className={`files-lease-fill ${statusClass(record.status)}`}
                            style={{ width: `${record.percentRemaining}%` }}
                          />
                        </div>
                        <p className="drops-open-status">
                          {record.blocksRemaining > 0
                            ? `${Math.round(record.percentRemaining)}% of storage time left (${formatNumber(record.blocksRemaining)} blocks)`
                            : `Expired ${formatNumber(Math.abs(record.blocksRemaining))} blocks ago`}
                        </p>
                      </div>
                    )}
                    <div className="actions-row">
                      <button
                        className="btn btn-pink"
                        type="button"
                        disabled={state.status === "working" || !authorized}
                        onClick={() => void renewFile(record)}
                      >
                        {state.status === "working" ? "Renewing..." : "Renew"}
                      </button>
                    </div>
                    {state.status !== "idle" && (
                      <p
                        className={
                          state.status === "error"
                            ? "drops-open-error"
                            : "drops-open-status"
                        }
                        role={state.status === "error" ? "alert" : undefined}
                      >
                        {state.message}
                      </p>
                    )}
                  </article>
                );
              })}
            </section>
          )}
        </>
      )}
    </main>
  );
}
