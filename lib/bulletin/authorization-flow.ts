export type BulletinAuthorizationStage =
  | "checking"
  | "authorizing"
  | "confirming"
  | "ready"
  | "error";

export type BulletinAuthorizationProgress = {
  stage: BulletinAuthorizationStage;
  message: string;
  source?: "existing" | "faucet";
  attempt?: number;
  totalAttempts?: number;
};

export type BulletinAuthorizationFlowOptions<TAuthorization> = {
  lookup: (force: boolean) => Promise<TAuthorization | null>;
  isActive: (authorization: TAuthorization) => boolean;
  authorize: (onProgress: (message: string) => void) => Promise<void>;
  confirmationAttempts?: number;
  confirmationDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

type ProgressListener = (progress: BulletinAuthorizationProgress) => void;

type ActiveRun<TAuthorization> = {
  listeners: Set<ProgressListener>;
  latest?: BulletinAuthorizationProgress;
  promise: Promise<TAuthorization>;
};

export class BulletinAuthorizationConfirmationError extends Error {
  readonly code = "BULLETIN_AUTHORIZATION_NOT_CONFIRMED";

  constructor(cause?: unknown) {
    super(
      "The Bulletin authorization transaction finalized, but the authorization was not visible on-chain.",
      cause === undefined ? undefined : { cause },
    );
    this.name = "BulletinAuthorizationConfirmationError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Coordinates one complete lookup -> faucet authorization -> confirmation run
 * per exact SS58 address. Concurrent React consumers share the underlying work
 * while every consumer receives the current and subsequent progress events.
 * Completed runs are deliberately not cached: every later connection checks
 * the chain again so expiration can never be hidden by browser state.
 */
export class BulletinAuthorizationCoordinator<TAuthorization> {
  private readonly activeRuns = new Map<string, ActiveRun<TAuthorization>>();

  ensure(
    address: string,
    options: BulletinAuthorizationFlowOptions<TAuthorization>,
    onProgress: ProgressListener,
  ): Promise<TAuthorization> {
    const existing = this.activeRuns.get(address);
    if (existing) {
      existing.listeners.add(onProgress);
      if (existing.latest) this.notify(onProgress, existing.latest);
      return existing.promise;
    }

    let resolveRun!: (authorization: TAuthorization) => void;
    let rejectRun!: (error: unknown) => void;
    const promise = new Promise<TAuthorization>((resolve, reject) => {
      resolveRun = resolve;
      rejectRun = reject;
    });
    const run: ActiveRun<TAuthorization> = {
      listeners: new Set([onProgress]),
      promise,
    };
    this.activeRuns.set(address, run);

    const emit = (progress: BulletinAuthorizationProgress) => {
      run.latest = progress;
      for (const listener of run.listeners) this.notify(listener, progress);
    };

    void this.execute(options, emit).then(
      (authorization) => {
        this.finish(address, run);
        resolveRun(authorization);
      },
      (error: unknown) => {
        emit({ stage: "error", message: errorMessage(error) });
        this.finish(address, run);
        rejectRun(error);
      },
    );

    return promise;
  }

  private finish(address: string, run: ActiveRun<TAuthorization>): void {
    if (this.activeRuns.get(address) === run) this.activeRuns.delete(address);
  }

  private notify(
    listener: ProgressListener,
    progress: BulletinAuthorizationProgress,
  ): void {
    try {
      listener(progress);
    } catch (error) {
      console.error("[soverstore:bulletin] Authorization progress listener failed", error);
    }
  }

  private async execute(
    options: BulletinAuthorizationFlowOptions<TAuthorization>,
    emit: (progress: BulletinAuthorizationProgress) => void,
  ): Promise<TAuthorization> {
    const attempts = Math.max(1, options.confirmationAttempts ?? 1);
    const delayMs = Math.max(0, options.confirmationDelayMs ?? 0);
    const sleep = options.sleep ?? defaultSleep;

    emit({
      stage: "checking",
      message: "Checking Bulletin authorization for the connected account...",
    });
    const current = await options.lookup(false);
    if (current && options.isActive(current)) {
      emit({
        stage: "ready",
        source: "existing",
        message: "Existing Bulletin authorization is active.",
      });
      return current;
    }

    emit({
      stage: "authorizing",
      message: current
        ? "Bulletin authorization expired. Starting automatic authorization..."
        : "No Bulletin authorization found. Starting automatic authorization...",
    });
    await options.authorize((message) => {
      emit({ stage: "authorizing", message });
    });

    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      emit({
        stage: "confirming",
        message:
          attempts === 1
            ? "Authorization finalized. Confirming it on Bulletin..."
            : `Authorization finalized. Confirming it on Bulletin (${attempt}/${attempts})...`,
        attempt,
        totalAttempts: attempts,
      });
      try {
        const confirmed = await options.lookup(true);
        if (confirmed && options.isActive(confirmed)) {
          emit({
            stage: "ready",
            source: "faucet",
            message: "Bulletin authorization is active.",
          });
          return confirmed;
        }
      } catch (error) {
        lastError = error;
      }

      if (attempt < attempts) await sleep(delayMs);
    }

    throw new BulletinAuthorizationConfirmationError(lastError);
  }
}
