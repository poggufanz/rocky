import { test } from "node:test";
import assert from "node:assert/strict";
import { signedExit, interceptCd } from "../ui/tui/surface/runcmd.js";

test("signedExit converts unsigned 32-bit errno, keeps small codes", () => {
  assert.equal(signedExit(4294963238), -4058);
  assert.equal(signedExit(1), 1);
  assert.equal(signedExit(0), 0);
});

test("pure cd resolves against session cwd when the directory exists", () => {
  const deps = { exists: (p: string) => p.replace(/\\/g, "/").endsWith("proj/rocky"), home: () => "/home/u" };
  const r = interceptCd("cd rocky", "/proj", deps);
  assert.ok(r && "next" in r && r.next.replace(/\\/g, "/").endsWith("proj/rocky"));
});

test("cd to a missing directory refuses honestly; bare cd goes home", () => {
  const deps = { exists: (p: string) => p === "/home/u", home: () => "/home/u" };
  const missing = interceptCd("cd nowhere", "/proj", deps);
  assert.ok(missing && "error" in missing);
  const home = interceptCd("cd", "/proj", deps);
  assert.ok(home && "next" in home && home.next === "/home/u");
});

test("compound cd passes through untouched", () => {
  const deps = { exists: () => true, home: () => "/h" };
  assert.equal(interceptCd("cd x && npm test", "/proj", deps), undefined);
  assert.equal(interceptCd("echo cd", "/proj", deps), undefined);
});
