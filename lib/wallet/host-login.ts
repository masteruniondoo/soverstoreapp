/**
 * Signing the user in to the Products host, ahead of any request for an account.
 *
 * `SignerManager.connect()` resolves an app-scoped product account and nothing
 * else: neither it nor `HostProvider` ever calls `requestLogin`. Inside Polkadot
 * Desktop or the mobile app a session already exists, so that is enough. A
 * browser tab on the gateway has no session, so the host answers with no account
 * and the connect fails with "Host wallet returned no accounts." - while the
 * pairing prompt that would have fixed it is never requested.
 *
 * `requestLogin` is what moves the host from Disconnected to Pairing, and Pairing
 * is the state that renders the QR code a phone scans. Asking for it costs
 * nothing when a session is already live: the host answers `AlreadyConnected`
 * without showing anything.
 *
 * The host calls are parameters rather than imports so the whole decision can be
 * exercised with no host present.
 */

/** The shape of a neverthrow `ResultAsync`, narrowed to what this flow uses. */
export type ResultLike<T> = {
  match<R>(onOk: (value: T) => R, onError: (error: unknown) => R): Promise<R>;
};

export type LoginAccountsProvider = {
  getUserId(): ResultLike<{ primaryUsername: string }>;
  requestLogin(reason?: string): ResultLike<string>;
};

export type HostLoginApi = {
  isInsideContainer(): Promise<boolean>;
  getAccountsProvider(): Promise<LoginAccountsProvider | null>;
};

export type HostLoginOutcome =
  /** A user is signed in to the host; an account can now be requested. */
  | { status: "logged-in"; username: string }
  /**
   * No host, or a host that exposes no accounts provider. Not diagnosed here:
   * SignerManager's own error names the supported ways to open the app, and
   * duplicating it would give one failure two different wordings.
   */
  | { status: "no-host" }
  /** The user saw the prompt and refused it. */
  | { status: "declined" }
  | { status: "failed"; detail: string };

export function describeHostError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export async function resolveHostLogin(
  api: HostLoginApi,
  reason: string,
): Promise<HostLoginOutcome> {
  if (!(await api.isInsideContainer())) return { status: "no-host" };

  const provider = await api.getAccountsProvider();
  if (!provider) return { status: "no-host" };

  // getUserId() failing is the ordinary "nobody is logged in yet" answer from
  // the host, not a fault. Only requestLogin raises the prompt.
  const existing = await provider.getUserId().match(
    (value) => value.primaryUsername,
    () => null,
  );
  if (existing !== null) return { status: "logged-in", username: existing };

  const login = await provider.requestLogin(reason).match(
    (response) => response,
    (error) => `error: ${describeHostError(error)}`,
  );

  if (login === "Rejected") return { status: "declined" };
  if (login !== "Success" && login !== "AlreadyConnected") {
    return { status: "failed", detail: login };
  }

  // A host that reports a login but still exposes no user has not finished the
  // handshake; treating that as success would only move the failure one step on.
  const username = await provider.getUserId().match(
    (value) => value.primaryUsername,
    () => null,
  );
  if (username === null) {
    return {
      status: "failed",
      detail: "the host reported a login but still exposes no user",
    };
  }

  return { status: "logged-in", username };
}
