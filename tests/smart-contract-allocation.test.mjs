import test from "node:test";
import assert from "node:assert/strict";
import {
  SmartContractAllocationCoordinator,
} from "../lib/wallet/smart-contract-allocation.ts";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test("coalesces concurrent allocation and reuses confirmed allowance", async () => {
  const coordinator = new SmartContractAllocationCoordinator(() => memoryStorage());
  let calls = 0;
  let release;
  const allocation = () => {
    calls += 1;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const first = coordinator.ensure("address-1", allocation);
  const second = coordinator.ensure("address-1", allocation);
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  await coordinator.ensure("address-1", allocation);
  assert.equal(calls, 1);
});

test("a host timeout becomes provisional and does not stack another request", async () => {
  let timedOut = 0;
  const coordinator = new SmartContractAllocationCoordinator(
    () => null,
    undefined,
    () => {
      timedOut += 1;
    },
  );
  let calls = 0;
  const allocation = async () => {
    calls += 1;
    throw new Error(
      "Smart-contract transaction allocation timed out after 30000ms.",
    );
  };
  await coordinator.ensure("address-1", allocation);
  await coordinator.ensure("address-1", allocation);
  assert.equal(calls, 1);
  assert.equal(timedOut, 1);
});

test("non-timeout failure is propagated and can be retried", async () => {
  const coordinator = new SmartContractAllocationCoordinator(() => null);
  let calls = 0;
  const allocation = async () => {
    calls += 1;
    if (calls === 1) throw new Error("Rejected");
  };
  await assert.rejects(coordinator.ensure("address-1", allocation), /Rejected/);
  await coordinator.ensure("address-1", allocation);
  assert.equal(calls, 2);
});

test("forget removes a cached grant so a no-allowance retry reallocates", async () => {
  const storage = memoryStorage();
  const coordinator = new SmartContractAllocationCoordinator(() => storage);
  let calls = 0;
  const allocation = async () => {
    calls += 1;
  };
  await coordinator.ensure("address-1", allocation);
  coordinator.forget("address-1");
  await coordinator.ensure("address-1", allocation);
  assert.equal(calls, 2);
});
