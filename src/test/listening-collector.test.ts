import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heartbeatCollector, releaseCollector, tryAcquireCollector } from "../listening/collector.js";

function freshHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-listen-col-")));
  mkdirSync(join(home, "listening"), { recursive: true });
  return home;
}

test("one owner per repo; release hands off", () => {
  const home = freshHome();
  const root = "/repo/collector-a";
  const a = tryAcquireCollector(root, { proc: "gui", pid: process.pid, token: "a" }, home);
  assert.equal(a.owner, true);
  const b = tryAcquireCollector(root, { proc: "mcp", pid: process.pid, token: "b" }, home);
  assert.equal(b.owner, false);
  releaseCollector(root, "wrong-token", home);
  assert.equal(tryAcquireCollector(root, { proc: "mcp", pid: process.pid, token: "b" }, home).owner, false);
  releaseCollector(root, "a", home);
  assert.equal(tryAcquireCollector(root, { proc: "mcp", pid: process.pid, token: "b" }, home).owner, true);
});

test("same token re-acquires and heartbeat renews", () => {
  const home = freshHome();
  const root = "/repo/collector-b";
  assert.equal(tryAcquireCollector(root, { proc: "gui", pid: process.pid, token: "a" }, home).owner, true);
  assert.equal(tryAcquireCollector(root, { proc: "gui", pid: process.pid, token: "a" }, home).owner, true);
  assert.equal(heartbeatCollector(root, "a", home), true);
  assert.equal(heartbeatCollector(root, "other", home), false);
});

test("dead-pid lease is stealable before expiry", () => {
  const home = freshHome();
  const root = "/repo/collector-c";
  const now = Date.now();
  const held = tryAcquireCollector(root, { proc: "gui", pid: 2147483647, token: "dead" }, home, now);
  assert.equal(held.owner, true);
  const stolen = tryAcquireCollector(root, { proc: "mcp", pid: process.pid, token: "live" }, home, now + 1000);
  assert.equal(stolen.owner, true);
});

test("invalid owner shapes are refused", () => {
  const home = freshHome();
  assert.equal(tryAcquireCollector("", { proc: "gui", pid: process.pid, token: "t" }, home).owner, false);
  assert.equal(tryAcquireCollector("/repo/x", { proc: "gui", pid: -1, token: "t" }, home).owner, false);
  assert.equal(tryAcquireCollector("/repo/x", { proc: "gui", pid: process.pid, token: "" }, home).owner, false);
});
