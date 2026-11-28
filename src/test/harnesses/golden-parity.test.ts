import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { batchKey } from "../../agent/schema.js";
import { readBatch } from "../../agent/spool.js";
import { agentEvent } from "../../commands/agent-hook.js";
import { cwdHash } from "../../core/attempt-note-state.js";
import { commandIdentity, fingerprint } from "../../core/fingerprint.js";
import { canonicalPath } from "../../core/memory-read.js";
import { resolveRockyPaths } from "../../core/state-paths.js";
import { handleListenEvent } from "../../listening/hook-ingress.js";
import { consentsPath, eventsPath, hostEventsPath } from "../../listening/store-paths.js";
import { failurePayload, passPayload } from "../tool-result-hook-fixture.js";

const entry = fileURLToPath(new URL("../../../dist/index.js", import.meta.url));
const now = 1_700_000_000_000;

function sandbox(t: TestContext) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rocky-harness-golden-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "work");
  mkdirSync(cwd);
  const home = join(root, "state");
  mkdirSync(home);
  return { cwd, home, paths: resolveRockyPaths({ ROCKY_HOME: home }) };
}

function hook(
  { home, cwd }: ReturnType<typeof sandbox>,
  args: string[],
  input = "",
  env: NodeJS.ProcessEnv = {},
): string {
  const result = spawnSync(process.execPath, [entry, "hook", ...args], {
    cwd, env: { ...process.env, ROCKY_HOME: home, ...env, NODE_OPTIONS: undefined, NODE_TEST_CONTEXT: undefined },
    input, encoding: "utf8", timeout: 30_000, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return result.stdout;
}

function rows(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
}

function stripGeneratedFields({ id, ts, ...record }: Record<string, unknown>) {
  assert.match(String(id), /^[\da-f-]{36}$/u);
  assert.equal(typeof ts, "number");
  return record;
}

test("golden tool-result failure and pass keep their stdout and persisted records", (t) => {
  const box = sandbox(t);
  const { cwd, paths } = box;
  const args = ["tool-result", "claude-code"];
  assert.equal(hook(box, args, failurePayload({ cwd })), "{}");
  const [failure] = rows(paths.memory);
  assert.ok(failure);
  const body = "Error: Cannot find module 'express'";
  const identity = commandIdentity("npm test");
  assert.deepEqual(rows(paths.memory).map(stripGeneratedFields), [{
    kind: "failure", cmd: "npm test", cwd, exitCode: 1, origin: "agent",
    agent: { vendor: "claude-code", session: "s1", toolUseId: "toolu_fail_1" },
    fingerprint: fingerprint(body, "npm test", 1), fingerprintV: 2,
    signature: ["error: cannot find module 'express'"], excerpt: body,
    commandIdentity: identity.value, identityV: identity.version, identityReliable: true, platform: process.platform,
  }]);
  assert.equal(hook(box, args, passPayload({ cwd })), "{}");
  const [original, fix, ...extra] = rows(paths.memory);
  assert.deepEqual(original, failure);
  assert.deepEqual(extra, []);
  assert.ok(fix);
  assert.deepEqual(stripGeneratedFields(fix), {
    kind: "fix", cmd: "npm test", cwd,
    agent: { vendor: "claude-code", session: "s1", toolUseId: "toolu_pass_1" },
    failureIds: [failure.id], links: [{ id: failure.id, basis: "identity", confidence: "confirmed" }],
    commandIdentity: identity.value, identityV: identity.version, identityReliable: true, platform: process.platform,
  });
  assert.deepEqual(rows(join(box.home, "advisories.jsonl")), []);
});

test("golden tool-result renders the prior-attempt advisory byte for byte", (t) => {
  const box = sandbox(t);
  const args = ["tool-result", "claude-code"];
  const input = failurePayload({ cwd: box.cwd });
  assert.equal(hook(box, args, input, { ROCKY_ATTEMPT_ADVISORY: "off" }), "{}");
  assert.equal(hook(box, args, input, { ROCKY_ATTEMPT_ADVISORY: "off" }), "{}");
  const [first] = rows(box.paths.memory);
  const date = new Date(Number(first?.ts)).toISOString().slice(0, 10);
  const note = `rocky: Same error recorded 2 times before in this directory (first ${date}). `
    + "After those runs: 1 rerun failed the same way. Rocky records order, not cause. More: rocky attempts 42e1f0ac4152f647";
  assert.equal(
    hook(box, args, input, { ROCKY_TEST_SEAMS: "1", ROCKY_ATTEMPT_ARM: "shown" }),
    `{"hookSpecificOutput":{"hookEventName":"PostToolUseFailure","additionalContext":${JSON.stringify(note)}}}`,
  );
});

test("golden Claude tool-result uses the failure header and the success hook as exit evidence", (t) => {
  const box = sandbox(t);
  const cwd = box.cwd;
  const args = ["tool-result", "claude-code"];
  assert.equal(hook(box, args, failurePayload({ cwd, tool_response: { exit_code: 0 } })), "{}");
  assert.equal(hook(box, args, passPayload({ cwd, tool_response: { exit_code: 5 } })), "{}");
  assert.equal(hook(box, args, failurePayload({ cwd, session_id: undefined, sessionId: "s1" })), "{}");
  const records = rows(box.paths.memory);
  assert.deepEqual(records.map(({ kind, exitCode }) => [kind, exitCode]), [["failure", 1], ["fix", undefined]]);
});

for (const [reason, overrides] of [
  ["interrupt", { is_interrupt: true }],
  ["background", { tool_input: { command: "npm test", run_in_background: true } }],
  ["wrapped", { tool_input: { command: 'rocky run "npm test"' } }],
  ["no-exit-header", { error: "Command ended before reporting a status" }],
] as const) {
  test(`golden tool-result ${reason} writes only its advisory skip row`, (t) => {
    const box = sandbox(t);
    assert.equal(hook(box, ["tool-result", "claude-code"], failurePayload({ cwd: box.cwd, ...overrides })), "{}");
    assert.deepEqual(rows(box.paths.memory), []);
    assert.equal(existsSync(box.paths.pending), false);
    const exposures = rows(join(box.home, "advisories.jsonl")).map(({ ts, latencyMs, ...record }) => {
      assert.equal(typeof ts, "number");
      assert.equal(typeof latencyMs, "number");
      return record;
    });
    assert.deepEqual(exposures, [{
      v: 1, session: "s1", lane: "tool-result", kind: "skip", arm: null, key: null,
      cwdHash: cwdHash(box.cwd), anchorFailureId: null, delivered: false, bytes: 0, reason,
    }]);
  });
}

for (const harnessId of ["claude-code", "codex"] as const) {
  for (const [hostConsent, repoConsent] of [[false, false], [false, true], [true, false], [true, true]]) {
    test(`golden Listening ${harnessId}, host=${hostConsent}, repo=${repoConsent}`, async (t) => {
      const { cwd, home } = sandbox(t);
      const repoRoot = canonicalPath(cwd);
      if (repoConsent) {
        const consents = consentsPath(home);
        mkdirSync(dirname(consents), { recursive: true });
        writeFileSync(consents, JSON.stringify({ [repoRoot]: true }));
      }
      const input = Buffer.from(JSON.stringify({
        nativeId: "native-a", sessionId: "session-a", episode: "episode-a", repoRoot,
        summaryRef: "summary-a", ts: now, ...(repoConsent ? { fileRel: "src/main.ts" } : {}),
        reason: "private reason", prompt: "private prompt", args: ["private args"],
        response: "private response", transcript: "private transcript", thinking: "private thinking",
        targetPaths: ["private.ts"],
      }));
      assert.deepEqual(
        await handleListenEvent(["listen-event", harnessId, "--surface", "cli"], input, { hostConsent }, home),
        {
          exit: 0, stdout: "", appended: hostConsent,
          reason: !hostConsent ? "host-consent-required" : repoConsent ? "appended-repo" : "appended-host",
        },
      );
      const host = rows(hostEventsPath(harnessId, home));
      const repo = rows(eventsPath(repoRoot, home));
      if (!hostConsent) {
        assert.deepEqual([...host, ...repo], []);
        return;
      }
      assert.deepEqual(repoConsent ? host : repo, []);
      const persisted = (repoConsent ? repo : host).map(({ eventId, ...record }) => {
        assert.match(String(eventId), /^[\da-f-]{36}$/u);
        return record;
      });
      assert.deepEqual(persisted, [{
        v: 1, source: "hook", harnessId, surface: "cli", ts: now, adapterVersion: "listening-hook-ingress/1",
        nativeId: "native-a", node: "agent_session", nodeId: "session-a",
        ...(repoConsent ? { repoRoot } : {}),
        consent: { host: true, repo: repoConsent, rawTrace: false },
        redaction: { applied: false, truncated: false }, coverage: "partial",
        refs: {
          session: "session-a", episode: "episode-a", summaryRef: "summary-a",
          ...(repoConsent ? { fileRel: "src/main.ts" } : {}),
        },
      }]);
    });
  }
}

test("Listening decodes native session IDs and omits file references without repository consent", async (t) => {
  const { cwd, home } = sandbox(t);
  for (const [harness, session] of [
    ["claude-code", { session_id: "native-claude" }],
    ["codex", { thread_id: "native-codex" }],
  ] as const) {
    const input = Buffer.from(JSON.stringify({ ...session, repoRoot: cwd, fileRel: "src/private.ts" }));
    const result = await handleListenEvent(["listen-event", harness, "--surface", "cli"], input, { hostConsent: true }, home);
    assert.deepEqual(result, { exit: 0, stdout: "", appended: true, reason: "appended-host" });
    const [event] = rows(hostEventsPath(harness, home));
    assert.deepEqual(event?.refs, { session: Object.values(session)[0] });
    assert.equal(event?.repoRoot, undefined);
  }
});

test("golden agent-event keeps Claude and Codex observed edits", (t) => {
  const box = sandbox(t);
  const patch = "*** Begin Patch\n*** Add File: src/b.ts\n+value\n*** End Patch";
  for (const [adapter, payload, expected] of [
    ["claude-code", {
      session_id: "session-a", prompt_id: "turn-a", hook_event_name: "PostToolUse", tool_name: "Edit",
      tool_input: { file_path: "src/a.ts", new_string: "export const value = 1;" },
    }, { tool: "Edit", path: "src/a.ts", excerpt: "export const value = 1;" }],
    ["codex", {
      session_id: "session-a", turn_id: "turn-a", hook_event_name: "PostToolUse", tool_name: "apply_patch",
      tool_input: { command: patch },
    }, { tool: "apply_patch", path: "src/b.ts", excerpt: patch }],
  ] as const) {
    const input = JSON.stringify({ ...payload, cwd: box.cwd });
    assert.equal(hook(box, ["agent-event", adapter], input), "{}");
    const [record, ...extra] = readBatch(batchKey(adapter, "session-a", "turn-a"), box.paths);
    assert.ok(record);
    assert.deepEqual(extra, []);
    const { ts, ...observed } = record;
    assert.equal(typeof ts, "number");
    assert.deepEqual(observed, {
      v: 1, kind: "mechanism", agent: adapter, ...expected, provenance: "tool-observed",
      coveragePaths: [adapter === "claude-code" ? canonicalPath(expected.path, { cwd: box.cwd }) : expected.path],
      coveragePathsComplete: true,
    });
  }
});

test("golden Codex notify uses argv in preference to stdin and closes the turn", async (t) => {
  const { paths } = sandbox(t);
  const text = "The retry now uses idempotency keys.";
  const argvPayload = JSON.stringify({
    type: "agent-turn-complete", "thread-id": "thread-a", "turn-id": "turn-a", "last-assistant-message": text,
  });
  const original = process.stdout.write;
  let stdout = "";
  const annotated: string[] = [];
  let readStdin = false;
  process.stdout.write = ((chunk: string, callback: () => void) => {
    stdout += chunk;
    callback();
    return true;
  }) as typeof original;
  let code: number;
  try {
    code = await agentEvent("codex", {
      argvPayload, paths, now: () => now, spawnAnnotate: (key) => annotated.push(key),
      stdin: async () => { readStdin = true; return ""; },
    });
  } finally {
    process.stdout.write = original;
  }
  const key = batchKey("codex", "thread-a", "turn-a");
  assert.equal(code, 0);
  assert.equal(stdout, "{}");
  assert.equal(readStdin, false);
  assert.deepEqual(annotated, [key]);
  assert.deepEqual(readBatch(key, paths), [{ v: 1, kind: "rationale", agent: "codex", ts: now, source: "notify", text }]);
});

test("golden generic agent-event records argv rationale with empty JSON stdout", (t) => {
  const box = sandbox(t);
  const excerpt = "Use idempotency keys to avoid duplicate retries.";
  assert.equal(hook(box, ["agent-event", "generic", "--rationale", excerpt, "--files", "src/main.ts"]), "{}");
  assert.deepEqual(rows(box.paths.memory).map(stripGeneratedFields), [{
    kind: "rationale", v: 1, cwd: box.cwd, agent: "generic", rationale_fidelity: "summary",
    source: "notify", excerpt, files: ["src/main.ts"],
  }]);
});
