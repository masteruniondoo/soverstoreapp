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

/**
 * The part of the host's ProductAccount this flow needs. Resolution is what
 * matters here - SignerManager holds the account itself - so this stays at the
 * two fields that identify it and cannot drift with the rest of the shape.
 */
export type LoginProductAccount = {
  dotNsIdentifier: string;
  derivationIndex: number;
};

export type LoginAccountsProvider = {
  getUserId(): ResultLike<{ primaryUsername: string }>;
  requestLogin(reason?: string): ResultLike<string>;
  getProductAccount(
    dotNsIdentifier: string,
    derivationIndex?: number,
  ): ResultLike<LoginProductAccount>;
};

export type HostLoginApi = {
  isInsideContainer(): Promise<boolean>;
  getAccountsProvider(): Promise<LoginAccountsProvider | null>;
};

export type HostLoginOutcome =
  /** A user is signed in and the app-scoped product account is resolved. */
  | { status: "logged-in"; username: string; account: LoginProductAccount }
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
  dotNsIdentifier: string,
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
  if (existing !== null) return resolveProductAccount(provider, dotNsIdentifier, existing);

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

  return resolveProductAccount(provider, dotNsIdentifier, username);
}

/**
 * Resolve the app-scoped product account, and report a failure as one.
 *
 * SignerManager does not: when the host cannot derive the account it logs a
 * warning and resolves connect() with an empty account list, so the app sees
 * "no accounts" and never learns why. Asking here keeps the host's own reason.
 */
async function resolveProductAccount(
  provider: LoginAccountsProvider,
  dotNsIdentifier: string,
  username: string,
): Promise<HostLoginOutcome> {
  type Resolved =
    | { ok: true; value: LoginProductAccount }
    | { ok: false; error: string };

  const account = await provider.getProductAccount(dotNsIdentifier, 0).match<Resolved>(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error: describeHostError(error) }),
  );

  if (!account.ok) {
    return {
      status: "failed",
      detail: `no product account for ${dotNsIdentifier}: ${account.error}`,
    };
  }

  return { status: "logged-in", username, account: account.value };
}
