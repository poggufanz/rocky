import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleListenEvent, LISTEN_INGRESS_MAX_BYTES } from "../listening/hook-ingress.js";
import { loadHostEvents } from "../listening/event-log-read.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const entry = join(packageRoot, "dist", "index.js");

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

test("process: rocky hook listen-event rejects oversized stdin whose prefix is valid JSON", (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-listen-proc-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "listening"), { recursive: true });

  const env: NodeJS.ProcessEnv = { ...process.env, ROCKY_HOME: home, ROCKY_LISTEN_HOSTS: "codex" };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;

  // Build a valid JSON document that finishes just inside the 64 KiB boundary,
  // then append trailing bytes past LISTEN_INGRESS_MAX_BYTES so the 64 KiB
  // prefix alone is still valid JSON.
  const prefixTemplate = JSON.stringify({ nativeId: "n-over", sessionId: "s-over", pad: "" });
  const padLen = LISTEN_INGRESS_MAX_BYTES - Buffer.byteLength(prefixTemplate, "utf8") - 16;
  const validNearCap = JSON.stringify({ nativeId: "n-over", sessionId: "s-over", pad: "a".repeat(padLen) });
  assert.equal(Buffer.byteLength(validNearCap, "utf8"), LISTEN_INGRESS_MAX_BYTES - 16);
  const oversized = validNearCap + " ".repeat(64);
  assert.equal(Buffer.byteLength(oversized, "utf8"), LISTEN_INGRESS_MAX_BYTES + 48);

  const rejected = spawnSync(process.execPath, [entry, "hook", "listen-event", "codex", "--surface", "cli"], {
    cwd: home,
    env,
    input: oversized,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  assert.equal(rejected.status, 0, rejected.stderr);
  assert.equal(rejected.stdout, "");
  assert.equal(loadHostEvents("codex", home).events.length, 0);

  // Confirm an exact-cap payload on the same CLI path is recorded.
  const exactTemplate = JSON.stringify({ nativeId: "n-exact", sessionId: "s-exact", pad: "" });
  const exactPad = LISTEN_INGRESS_MAX_BYTES - Buffer.byteLength(exactTemplate, "utf8");
  const exactPayload = JSON.stringify({ nativeId: "n-exact", sessionId: "s-exact", pad: "b".repeat(exactPad) });
  assert.equal(Buffer.byteLength(exactPayload, "utf8"), LISTEN_INGRESS_MAX_BYTES);

  const accepted = spawnSync(process.execPath, [entry, "hook", "listen-event", "codex", "--surface", "cli"], {
    cwd: home,
    env,
    input: exactPayload,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.stdout, "");
  const { events } = loadHostEvents("codex", home);
  assert.equal(events.length, 1);
  assert.equal(events[0].nodeId, "s-exact");
});
