export type AllocationStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

type AllocationStatus = "confirmed" | "provisional";

export function isSmartContractAllocationTimeout(error: unknown): boolean {
  return error instanceof Error &&
    error.message.includes("Smart-contract transaction allocation timed out");
}

export class SmartContractAllocationCoordinator {
  private readonly statusByAddress = new Map<string, AllocationStatus>();
  private readonly requests = new Map<string, Promise<void>>();
  private readonly storage: () => AllocationStorage | null;
  private readonly keyPrefix: string;
  private readonly onTimeout?: (address: string) => void;

  constructor(
    storage: () => AllocationStorage | null,
    keyPrefix = "soverstore:smart-contract-allowance:",
    onTimeout?: (address: string) => void,
  ) {
    this.storage = storage;
    this.keyPrefix = keyPrefix;
    this.onTimeout = onTimeout;
  }

  private key(address: string): string {
    return `${this.keyPrefix}${address}`;
  }

  private remembered(address: string): AllocationStatus | undefined {
    const current = this.statusByAddress.get(address);
    if (current) return current;
    try {
      if (this.storage()?.getItem(this.key(address)) === "1") {
        this.statusByAddress.set(address, "confirmed");
        return "confirmed";
      }
    } catch {
      // Sandboxed hosts may deny storage; the in-memory cache still works.
    }
    return undefined;
  }

  private remember(address: string, status: AllocationStatus): void {
    this.statusByAddress.set(address, status);
    if (status !== "confirmed") return;
    try {
      this.storage()?.setItem(this.key(address), "1");
    } catch {
      // Allocation remains cached for this mounted application instance.
    }
  }

  ensure(address: string, allocate: () => Promise<void>): Promise<void> {
    if (this.remembered(address)) return Promise.resolve();
    const existing = this.requests.get(address);
    if (existing) return existing;

    const pending = (async () => {
      try {
        await allocate();
        this.remember(address, "confirmed");
      } catch (error) {
        if (!isSmartContractAllocationTimeout(error)) throw error;

        // A local timeout cannot cancel the host request or prove allocation
        // failed. A provisional marker prevents retries from stacking more
        // requests while the existing transaction path checks the real state.
        this.remember(address, "provisional");
        this.onTimeout?.(address);
      }
    })().finally(() => {
      if (this.requests.get(address) === pending) {
        this.requests.delete(address);
      }
    });
    this.requests.set(address, pending);
    return pending;
  }

  forget(address: string): void {
    this.statusByAddress.delete(address);
    try {
      this.storage()?.removeItem(this.key(address));
    } catch {
      // Nothing else is required when storage is unavailable.
    }
  }
}
