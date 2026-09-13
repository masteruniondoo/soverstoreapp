import test from "node:test";
import assert from "node:assert/strict";
import { resolveHostLogin } from "../lib/wallet/host-login.ts";

const REASON = "because the app needs an account";

/** A neverthrow-shaped result: ok values go left, errors go right. */
function ok(value) {
  return { match: async (onOk) => onOk(value) };
}
function err(error) {
  return { match: async (_onOk, onError) => onError(error) };
}

/**
 * A fake host. `users` is the queue getUserId() answers from, so a test can say
 * "nobody, then somebody" the way a real login behaves.
 */
function fakeHost({ inside = true, provider = "default", users = [], login = ok("Success") } = {}) {
  const calls = { login: 0, reason: null };
  const queue = [...users];
  const accounts = {
    getUserId: () => {
      const next = queue.length > 0 ? queue.shift() : null;
      return next === null ? err({ tag: "NotLoggedIn" }) : ok({ primaryUsername: next });
    },
    requestLogin: (reason) => {
      calls.login += 1;
      calls.reason = reason;
      return login;
    },
  };
  return {
    calls,
    api: {
      isInsideContainer: async () => inside,
      getAccountsProvider: async () => (provider === "default" ? accounts : provider),
    },
  };
}

test("outside a host, nothing is asked of the user", async () => {
  const host = fakeHost({ inside: false });
  const outcome = await resolveHostLogin(host.api, REASON);
  assert.deepEqual(outcome, { status: "no-host" });
  assert.equal(host.calls.login, 0);
});

test("a host exposing no accounts provider is reported as no-host", async () => {
  const host = fakeHost({ provider: null });
  assert.deepEqual(await resolveHostLogin(host.api, REASON), { status: "no-host" });
});

test("an existing session is used as-is and raises no prompt", async () => {
  const host = fakeHost({ users: ["alice"] });
  const outcome = await resolveHostLogin(host.api, REASON);
  assert.deepEqual(outcome, { status: "logged-in", username: "alice" });
  // The Desktop and mobile path: a prompt here would be a regression.
  assert.equal(host.calls.login, 0);
});

test("with no session, the login prompt is requested and the reason forwarded", async () => {
  const host = fakeHost({ users: [null, "bob"], login: ok("Success") });
  const outcome = await resolveHostLogin(host.api, REASON);
  assert.deepEqual(outcome, { status: "logged-in", username: "bob" });
  assert.equal(host.calls.login, 1);
  assert.equal(host.calls.reason, REASON);
});

test("AlreadyConnected is a success, not an error", async () => {
  const host = fakeHost({ users: [null, "carol"], login: ok("AlreadyConnected") });
  assert.deepEqual(await resolveHostLogin(host.api, REASON), {
    status: "logged-in",
    username: "carol",
  });
});

test("a refused prompt is reported as declined", async () => {
  const host = fakeHost({ users: [null], login: ok("Rejected") });
  assert.deepEqual(await resolveHostLogin(host.api, REASON), { status: "declined" });
});

test("an unrecognised login response fails instead of being assumed good", async () => {
  const host = fakeHost({ users: [null], login: ok("SomethingNew") });
  assert.deepEqual(await resolveHostLogin(host.api, REASON), {
    status: "failed",
    detail: "SomethingNew",
  });
});

test("a host error carries its detail into the failure", async () => {
  const host = fakeHost({ users: [null], login: err(new Error("port closed")) });
  const outcome = await resolveHostLogin(host.api, REASON);
  assert.equal(outcome.status, "failed");
  assert.match(outcome.detail, /port closed/);
});

test("a login the host cannot back with a user is not treated as connected", async () => {
  // Success, then getUserId still empty: the handshake did not finish.
  const host = fakeHost({ users: [null, null], login: ok("Success") });
  const outcome = await resolveHostLogin(host.api, REASON);
  assert.equal(outcome.status, "failed");
  assert.match(outcome.detail, /still exposes no user/);
});
