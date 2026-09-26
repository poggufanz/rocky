import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleListenEvent, LISTEN_INGRESS_MAX_BYTES } from "../listening/hook-ingress.js";

function withHome(t: import("node:test").TestContext): string {
  const home = mkdtempSync(join(tmpdir(), "rocky-listen-hook-"));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}

test("hook ingress fails open with empty stdout on bad argv", async (t) => {
  withHome(t);
  for (const argv of [
    ["listen-event"],
    ["listen-event", "bogus-id", "--surface", "cli"],
    ["listen-event", "codex", "--surface", "bogus"],
    ["listen-event", "codex", "cli"],
  ]) {
    const result = await handleListenEvent(argv, Buffer.from("{}"), { hostConsent: true }, process.env.ROCKY_HOME);
    assert.equal(result.exit, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.appended, false);
  }
});

test("hook ingress drops generic reason prompt args and keeps allowlist", async (t) => {
  const home = withHome(t);
  const payload = JSON.stringify({
    session_id: "s1",
    reason: "generic reason must not map",
    prompt: "user prompt must not store",
    args: ["--secret"],
    responses: [{ text: "x" }],
    hook_policy_reason: "policy note stays separate",
  });
  const result = await handleListenEvent(
    ["listen-event", "codex", "--surface", "cli"],
    Buffer.from(payload),
    { hostConsent: true },
    home,
  );
  assert.equal(result.exit, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.appended, true);
  assert.equal(result.reason, "appended-host");
});

test("hook ingress refuses without host consent and on oversize", async (t) => {
  const home = withHome(t);
  const denied = await handleListenEvent(
    ["listen-event", "codex", "--surface", "cli"],
    Buffer.from("{}"),
    { hostConsent: false },
    home,
  );
  assert.equal(denied.appended, false);
  assert.equal(denied.stdout, "");
  const big = await handleListenEvent(
    ["listen-event", "codex", "--surface", "cli"],
    Buffer.alloc(LISTEN_INGRESS_MAX_BYTES + 1),
    { hostConsent: true },
    home,
  );
  assert.equal(big.appended, false);
  assert.equal(big.reason, "stdin-oversized");
  const malformed = await handleListenEvent(
    ["listen-event", "codex", "--surface", "cli"],
    Buffer.from("NOT JSON"),
    { hostConsent: true },
    home,
  );
  assert.equal(malformed.appended, false);
  assert.equal(malformed.reason, "stdin-malformed");
});

test("hook ingress never throws", async (t) => {
  withHome(t);
  const result = await handleListenEvent(["nope"], null as never, { hostConsent: true });
  assert.equal(result.exit, 0);
  assert.equal(result.stdout, "");
});
