import assert from "node:assert/strict";
import { test } from "node:test";
import {
  filterCheckable,
  newDependencyNames,
  parseLockfilePackageKeys,
} from "../check/deps.js";

test("newDependencyNames finds newly named dependencies in every dependency section", () => {
  const oldJson = JSON.stringify({
    dependencies: { runtimeExisting: "1.0.0" },
    devDependencies: { devExisting: "1.0.0" },
    optionalDependencies: { optionalExisting: "1.0.0" },
    peerDependencies: { peerExisting: "1.0.0" },
  });
  const newJson = JSON.stringify({
    dependencies: { runtimeExisting: "2.0.0", runtimeNew: "1.0.0" },
    devDependencies: { devExisting: "2.0.0", devNew: "1.0.0" },
    optionalDependencies: { optionalExisting: "2.0.0", optionalNew: "1.0.0" },
    peerDependencies: { peerExisting: "2.0.0", peerNew: "1.0.0" },
  });

  assert.deepEqual(newDependencyNames(oldJson, newJson), [
    { name: "runtimeNew", spec: "1.0.0" },
    { name: "devNew", spec: "1.0.0" },
    { name: "optionalNew", spec: "1.0.0" },
    { name: "peerNew", spec: "1.0.0" },
  ]);
});

test("newDependencyNames treats only an absent old manifest as having no dependencies", () => {
  const newJson = JSON.stringify({ dependencies: { x: "1" } });

  assert.deepEqual(newDependencyNames(null, newJson), [{ name: "x", spec: "1" }]);
  assert.equal(newDependencyNames("{not json", newJson), null);
  assert.deepEqual(newDependencyNames(null, "{not json"), []);
});

test("filterCheckable skips every local dependency protocol", () => {
  const result = filterCheckable([
    { name: "workspace-pkg", spec: "workspace:*" },
    { name: "file-pkg", spec: "file:../local" },
    { name: "link-pkg", spec: "link:../local" },
    { name: "portal-pkg", spec: "portal:../local" },
  ], { npmrc: null, lockfilePackageKeys: new Set() });

  assert.deepEqual(result.check, []);
  assert.deepEqual(result.skipped, [
    { name: "workspace-pkg", reason: "local protocol" },
    { name: "file-pkg", reason: "local protocol" },
    { name: "link-pkg", reason: "local protocol" },
    { name: "portal-pkg", reason: "local protocol" },
  ]);
});

test("filterCheckable skips dependencies covered by global and scoped registry overrides", () => {
  const deps = [
    { name: "public-pkg", spec: "^1.0.0" },
    { name: "@corp/private", spec: "^1.0.0" },
    { name: "@other/public", spec: "^1.0.0" },
  ];

  const scoped = filterCheckable(deps, {
    npmrc: "@corp:registry=https://npm.corp.example\n",
    lockfilePackageKeys: new Set(),
  });
  assert.deepEqual(scoped.check, ["public-pkg", "@other/public"]);
  assert.deepEqual(scoped.skipped, [{ name: "@corp/private", reason: "scoped registry override" }]);

  const global = filterCheckable(deps, {
    npmrc: "registry=https://npm.corp.example\n",
    lockfilePackageKeys: new Set(),
  });
  assert.deepEqual(global.check, []);
  assert.deepEqual(global.skipped.map(({ name }) => name), ["public-pkg", "@corp/private", "@other/public"]);
});

test("filterCheckable uses exact structural package-lock keys", () => {
  const locked = parseLockfilePackageKeys(JSON.stringify({
    packages: { "node_modules/locked-pkg": {} },
  }));
  const resolved = filterCheckable([{ name: "locked-pkg", spec: "^1.0.0" }], {
    npmrc: null,
    lockfilePackageKeys: locked,
  });
  assert.deepEqual(resolved.check, []);
  assert.deepEqual(resolved.skipped, [{ name: "locked-pkg", reason: "already resolved in lockfile" }]);

  const lookalikes = parseLockfilePackageKeys(JSON.stringify({
    note: "node_modules/locked-pkg",
    packages: { "node_modules/locked-pkg-extra": {} },
  }));
  const unresolved = filterCheckable([{ name: "locked-pkg", spec: "^1.0.0" }], {
    npmrc: null,
    lockfilePackageKeys: lookalikes,
  });
  assert.deepEqual(unresolved.check, ["locked-pkg"]);
  assert.deepEqual(unresolved.skipped, []);
});

test("parseLockfilePackageKeys tolerates null and malformed lockfiles", () => {
  assert.deepEqual([...parseLockfilePackageKeys(null)], []);
  assert.deepEqual([...parseLockfilePackageKeys("{not json")], []);
});
