import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as recovery from "../lib/artifacts/recovery.ts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const SOURCE_DIRECTORIES = ["app", "components", "lib"];

/**
 * The one place the retired format may still be named: it reads old recovery
 * documents and never writes one.
 */
const LEGACY_READER = path.join("lib", "artifacts", "recovery-legacy.ts");

function sourceFiles() {
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
      const absolute = path.join(directory, entry);
      if (statSync(absolute).isDirectory()) {
        walk(absolute);
      } else if (/\.(ts|tsx)$/.test(entry)) {
        found.push(path.relative(projectRoot, absolute));
      }
    }
  };
  for (const directory of SOURCE_DIRECTORIES) {
    walk(path.join(projectRoot, directory));
  }
  return found;
}

test("nothing but the legacy reader still knows the recovery JSON format", () => {
  const offenders = sourceFiles().filter(
    (file) =>
      file !== LEGACY_READER &&
      readFileSync(path.join(projectRoot, file), "utf8").includes(
        "proofbox/recovery@1",
      ),
  );
  assert.deepEqual(offenders, []);
});

test("no source file writes a recovery JSON artifact", () => {
  const offenders = sourceFiles().filter(
    (file) =>
      file !== LEGACY_READER &&
      /\.recovery\.json|downloadRecovery\b|buildRecovery\b/.test(
        readFileSync(path.join(projectRoot, file), "utf8"),
      ),
  );
  assert.deepEqual(offenders, []);
});

test("the legacy reader only reads", () => {
  const source = readFileSync(path.join(projectRoot, LEGACY_READER), "utf8");
  assert.ok(source.includes("JSON.parse"));
  assert.equal(source.includes("JSON.stringify"), false);
});

test("the recovery module offers no way to build a recovery document", () => {
  const exported = Object.keys(recovery);
  for (const name of ["buildRecovery", "downloadRecovery", "parseRecovery"]) {
    assert.equal(exported.includes(name), false, `${name} is still exported`);
  }
  assert.ok(exported.includes("generateRecoveryKey"));
  assert.ok(exported.includes("formatRecoveryText"));
});
