import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleListenEvent, LISTEN_INGRESS_MAX_BYTES } from "../listening/hook-ingress.js";
import { loadHostEvents } from "../listening/event-log-read.js";

function freshHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-listen-hook-")));
  mkdirSync(join(home, "listening"), { recursive: true });
  return home;
}

function payload(value: Record<string, unknown>): Uint8Array {
  return Buffer.from(JSON.stringify(value), "utf8");
}

test("valid ingress appends with empty stdout and exit 0", async () => {
  const home = freshHome();
  const out = await handleListenEvent(
    ["listen-event", "codex", "--surface", "cli"],
    payload({ nativeId: "n9", sessionId: "s9" }),
    { hostConsent: true },
    home,
  );
  assert.equal(out.exit, 0);
  assert.equal(out.stdout, "");
  assert.equal(out.appended, true);
  assert.equal(out.reason, "appended-host");
  const { events } = loadHostEvents("codex", home);
  assert.equal(events.length, 1);
  assert.equal(events[0].nodeId, "s9");
});

test("bad argv, harness, surface, and consent fail open", async () => {
  const home = freshHome();
  const good = payload({ nativeId: "n1" });
  assert.equal((await handleListenEvent(["listen-event", "codex"], good, { hostConsent: true }, home)).reason, "bad-argv");
  assert.equal((await handleListenEvent(["listen-event", "nope", "--surface", "cli"], good, { hostConsent: true }, home)).reason, "bad-harness-id");
  assert.equal((await handleListenEvent(["listen-event", "codex", "--surface", "cloud"], good, { hostConsent: true }, home)).reason, "bad-surface");
  assert.equal((await handleListenEvent(["listen-event", "codex", "--surface", "cli"], good, { hostConsent: false }, home)).reason, "host-consent-required");
  for (const out of [
    await handleListenEvent(["listen-event", "codex", "--surface", "cli"], good, { hostConsent: true }, home),
  ]) {
    assert.equal(out.exit, 0);
    assert.equal(out.stdout, "");
  }
});

test("oversized and malformed stdin fail open", async () => {
  const home = freshHome();
  const big = await handleListenEvent(
    ["listen-event", "codex", "--surface", "cli"],
    new Uint8Array(LISTEN_INGRESS_MAX_BYTES + 1),
    { hostConsent: true },
    home,
  );
  assert.equal(big.appended, false);
  assert.equal(big.reason, "stdin-oversized");
  const malformed = await handleListenEvent(
    ["listen-event", "codex", "--surface", "cli"],
    Buffer.from("{oops", "utf8"),
    { hostConsent: true },
    home,
  );
  assert.equal(malformed.appended, false);
  assert.equal(malformed.reason, "stdin-malformed");
});

test("generic reason, prompt, and transcript fields are never stored", async () => {
  const home = freshHome();
  await handleListenEvent(
    ["listen-event", "codex", "--surface", "cli"],
    payload({ nativeId: "n-secret", sessionId: "s1", reason: "because I said so", prompt: "hunter2", transcript: "full log" }),
    { hostConsent: true },
    home,
  );
  const { events } = loadHostEvents("codex", home);
  assert.equal(events.length, 1);
  const serialized = JSON.stringify(events[0]);
  assert.ok(!serialized.includes("because I said so"));
  assert.ok(!serialized.includes("hunter2"));
  assert.ok(!serialized.includes("full log"));
  assert.equal(events[0].hookPolicyReason, undefined);
});

test("duplicate nativeId is idempotent", async () => {
  const home = freshHome();
  const args = ["listen-event", "gemini-cli", "--surface", "local"];
  const first = await handleListenEvent(args, payload({ nativeId: "dup" }), { hostConsent: true }, home);
  const again = await handleListenEvent(args, payload({ nativeId: "dup" }), { hostConsent: true }, home);
  assert.equal(first.appended, true);
  assert.equal(again.appended, true);
  assert.equal(loadHostEvents("gemini-cli", home).events.length, 1);
});
