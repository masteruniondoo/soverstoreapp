import type { PolkadotSigner } from "polkadot-api";
import { getChainAPI } from "@parity/product-sdk/chain";
import {
  createContract,
  createContractRuntimeFromClient,
  ensureContractAccountMapped,
  type AbiEntry,
} from "@parity/product-sdk/contracts";
import { devnet_asset_hub } from "@parity/product-sdk-descriptors/devnet-asset-hub";
import type { AppWalletAccount } from "@/lib/wallet";

export const DROPS_PACKAGE = "@soverstore/drops";
export const DROPS_CONTRACT_ADDRESS =
  "0x6E084A5d49ac47538bDdcb169Bea5A5E67BC4EdC";
export const REVIVE_VALUE_FACTOR = 10n ** 8n;
export const PAS_CONTRACT_UNIT = 10n ** 18n;
export const PAS_SDK_UNIT = 10n ** 10n;
export const BUY_GAS_RESERVE_SDK = PAS_SDK_UNIT / 10n;

export type DropInfo = {
  id: bigint;
  name: string;
  price: bigint;
  payDeadline: bigint;
  cid: string;
  published: boolean;
  buyerCount: bigint;
};

export type DropBuyerKeys = {
  buyers: string[];
  publicKeys: Uint8Array[];
};

export type DropsTxStatus =
  | "signing"
  | "broadcasting"
  | "in-block"
  | "finalized"
  | "error";

export type DropsTxOptions = {
  onStatus?: (status: DropsTxStatus) => void;
};

export type DropsTxReceipt = {
  txHash: string;
  blockHash: string;
  blockNumber: number;
  events: unknown[];
};

export type AssetHubBalance = {
  free: bigint;
  frozen: bigint;
  spendable: bigint;
};

const input = (name: string, type: string) => ({ name, type });
const fn = (
  name: string,
  stateMutability: "view" | "nonpayable" | "payable",
  inputs: { name: string; type: string }[],
  outputs: { name: string; type: string }[] = [],
): AbiEntry => ({ type: "function", name, stateMutability, inputs, outputs });

const DROPS_ABI: AbiEntry[] = [
  fn("owner", "view", [], [input("", "address")]),
  fn("dropCount", "view", [], [input("", "uint256")]),
  fn("createDrop", "nonpayable", [input("name", "string"), input("price", "uint256"), input("payDeadline", "uint64")], [input("id", "uint256")]),
  fn("buy", "payable", [input("id", "uint256"), input("encPubKey", "bytes")]),
  fn("addEnvelopes", "nonpayable", [input("id", "uint256"), input("buyers", "address[]"), input("envelopes", "bytes[]")]),
  fn("publish", "nonpayable", [input("id", "uint256"), input("cid", "string")]),
  fn("dropInfo", "view", [input("id", "uint256")], [input("name", "string"), input("price", "uint256"), input("payDeadline", "uint64"), input("cid", "string"), input("published", "bool"), input("buyerCount", "uint256")]),
  fn("buyersOf", "view", [input("id", "uint256")], [input("", "address[]")]),
  fn("buyerKeys", "view", [input("id", "uint256")], [input("addrs", "address[]"), input("keys", "bytes[]")]),
  fn("isBuyer", "view", [input("id", "uint256"), input("who", "address")], [input("", "bool")]),
  fn("encKeyOf", "view", [input("", "uint256"), input("", "address")], [input("", "bytes")]),
  fn("envelopeOf", "view", [input("", "uint256"), input("", "address")], [input("", "bytes")]),
  fn("withdraw", "nonpayable", [input("to", "address")]),
];

type RawContract = ReturnType<typeof createContract>;
type QueryResponse<T> = { success: boolean; value: T };
type RawTxResult = {
  ok: boolean;
  value?: {
    ok: boolean;
    txHash: string;
    block: { hash: string; number: number };
    events: unknown[];
    dispatchError?: unknown;
  };
  error?: unknown;
};

let runtimePromise: ReturnType<typeof buildRuntime> | null = null;

async function buildRuntime() {
  const chain = await getChainAPI("devnet");
  return createContractRuntimeFromClient(
    chain.raw.assetHub,
    devnet_asset_hub,
  );
}

function runtime() {
  runtimePromise ??= buildRuntime();
  return runtimePromise;
}

function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value, (_, item) =>
      typeof item === "bigint" ? item.toString() : item,
    );
  } catch {
    return String(value);
  }
}

function queryValue<T>(method: string, result: QueryResponse<T>): T {
  if (!result.success) {
    throw new Error(`${method} query failed: ${messageOf(result.value)}`);
  }
  return result.value;
}

function bytesToHex(bytes: Uint8Array): `0x${string}` {
  return `0x${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

function hexToBytes(value: unknown, label: string): Uint8Array {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new Error(`${label} returned invalid contract bytes.`);
  }
  const bytes = new Uint8Array((value.length - 2) / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
  }
  return bytes;
}

function requireRecord(value: unknown, method: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${method} returned an unexpected value.`);
  }
  return value as Record<string, unknown>;
}

function requireBigInt(value: unknown, label: string): bigint {
  if (typeof value !== "bigint") throw new Error(`${label} is not a bigint.`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is not a string.`);
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} is not a boolean.`);
  return value;
}

function requireAddressArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} is not an address array.`);
  }
  return value as string[];
}

async function receipt(resultPromise: Promise<unknown>): Promise<DropsTxReceipt> {
  const result = await resultPromise as RawTxResult;
  if (!result.ok) throw result.error;
  if (!result.value?.ok) {
    throw new Error(`Transaction dispatch failed: ${messageOf(result.value?.dispatchError)}`);
  }
  return {
    txHash: result.value.txHash,
    blockHash: result.value.block.hash,
    blockNumber: result.value.block.number,
    events: result.value.events,
  };
}

function txOptions(options?: DropsTxOptions) {
  return {
    waitFor: "finalized" as const,
    onStatus: options?.onStatus,
  };
}

function requireSigner(account: AppWalletAccount | undefined): AppWalletAccount {
  if (!account) throw new Error("A connected host signer is required for this transaction.");
  return account;
}

export function contractPriceToSdkValue(price: bigint): bigint {
  if (price < 0n) throw new Error("Price cannot be negative.");
  return (price + REVIVE_VALUE_FACTOR - 1n) / REVIVE_VALUE_FACTOR;
}

export async function getAssetHubBalance(
  ss58Address: string,
): Promise<AssetHubBalance> {
  const chain = await getChainAPI("devnet");
  const account = await chain.assetHub.query.System.Account.getValue(ss58Address);
  const free = account.data.free;
  const frozen = account.data.frozen;
  return {
    free,
    frozen,
    spendable: free > frozen ? free - frozen : 0n,
  };
}

export class DropsContractClient {
  constructor(
    private readonly contract: RawContract,
    private readonly account?: AppWalletAccount,
  ) {}

  async owner(): Promise<string> {
    return requireString(queryValue("owner", await this.contract.owner.query()), "owner");
  }

  async dropCount(): Promise<bigint> {
    return requireBigInt(queryValue("dropCount", await this.contract.dropCount.query()), "dropCount");
  }

  async dropInfo(id: bigint): Promise<DropInfo> {
    const value = requireRecord(queryValue("dropInfo", await this.contract.dropInfo.query(id)), "dropInfo");
    return {
      id,
      name: requireString(value.name, "dropInfo.name"),
      price: requireBigInt(value.price, "dropInfo.price"),
      payDeadline: requireBigInt(value.payDeadline, "dropInfo.payDeadline"),
      cid: requireString(value.cid, "dropInfo.cid"),
      published: requireBoolean(value.published, "dropInfo.published"),
      buyerCount: requireBigInt(value.buyerCount, "dropInfo.buyerCount"),
    };
  }

  async buyersOf(id: bigint): Promise<string[]> {
    return requireAddressArray(queryValue("buyersOf", await this.contract.buyersOf.query(id)), "buyersOf");
  }

  async buyerKeys(id: bigint): Promise<DropBuyerKeys> {
    const value = requireRecord(queryValue("buyerKeys", await this.contract.buyerKeys.query(id)), "buyerKeys");
    const buyers = requireAddressArray(value.addrs, "buyerKeys.addrs");
    if (!Array.isArray(value.keys) || value.keys.length !== buyers.length) {
      throw new Error("buyerKeys returned mismatched addresses and keys.");
    }
    return {
      buyers,
      publicKeys: value.keys.map((key, index) =>
        hexToBytes(key, `buyerKeys.keys[${index}]`),
      ),
    };
  }

  async isBuyer(id: bigint, address: string): Promise<boolean> {
    return requireBoolean(queryValue("isBuyer", await this.contract.isBuyer.query(id, address)), "isBuyer");
  }

  async encKeyOf(id: bigint, address: string): Promise<Uint8Array> {
    return hexToBytes(queryValue("encKeyOf", await this.contract.encKeyOf.query(id, address)), "encKeyOf");
  }

  async envelopeOf(id: bigint, address: string): Promise<Uint8Array> {
    return hexToBytes(queryValue("envelopeOf", await this.contract.envelopeOf.query(id, address)), "envelopeOf");
  }

  async createDrop(name: string, price: bigint, payDeadline: bigint, options?: DropsTxOptions): Promise<DropsTxReceipt> {
    requireSigner(this.account);
    return receipt(this.contract.createDrop.tx(name, price, payDeadline, txOptions(options)));
  }

  async buy(id: bigint, publicKeyRaw: Uint8Array, price: bigint, options?: DropsTxOptions): Promise<DropsTxReceipt> {
    requireSigner(this.account);
    return receipt(this.contract.buy.tx(id, bytesToHex(publicKeyRaw), {
      ...txOptions(options),
      value: contractPriceToSdkValue(price),
    }));
  }

  async addEnvelopes(id: bigint, buyers: string[], envelopes: Uint8Array[], options?: DropsTxOptions): Promise<DropsTxReceipt> {
    requireSigner(this.account);
    return receipt(this.contract.addEnvelopes.tx(
      id,
      buyers,
      envelopes.map(bytesToHex),
      txOptions(options),
    ));
  }

  async publish(id: bigint, cid: string, options?: DropsTxOptions): Promise<DropsTxReceipt> {
    requireSigner(this.account);
    return receipt(this.contract.publish.tx(id, cid, txOptions(options)));
  }

  async withdraw(to: string, options?: DropsTxOptions): Promise<DropsTxReceipt> {
    requireSigner(this.account);
    const estimate = await this.contract.withdraw.query(to);
    if (!estimate.success) {
      throw new Error(`withdraw query failed: ${messageOf(estimate.value)}`);
    }
    const gasLimit = {
      ref_time: estimate.gasRequired.ref_time * 2n,
      proof_size: estimate.gasRequired.proof_size * 2n,
    };
    return receipt(this.contract.withdraw.tx(to, {
      ...txOptions(options),
      gasLimit,
    }));
  }
}

export async function createDropsContractClient(
  account?: AppWalletAccount,
): Promise<DropsContractClient> {
  const contractRuntime = await runtime();
  if (account) {
    const mapped = await ensureContractAccountMapped(
      contractRuntime,
      account.address,
      account.polkadotSigner as PolkadotSigner,
    );
    if (!mapped.ok) throw mapped.error;
  }
  const contract = createContract(
    contractRuntime,
    DROPS_CONTRACT_ADDRESS,
    DROPS_ABI,
    account
      ? {
          defaultOrigin: account.address,
          defaultSigner: account.polkadotSigner,
        }
      : undefined,
  );
  return new DropsContractClient(contract, account);
}
