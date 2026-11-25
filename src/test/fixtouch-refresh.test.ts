import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { collectFixTouchEntries, rebuildFixTouchCache } from "../commands/fixtouch-refresh.js";
import { hookFail, hookSuccess } from "../commands/hook.js";
import { toolResultHook } from "../commands/tool-result-hook.js";
import type { Attempt, AttemptOutcome, ProblemEntry } from "../core/attempts.js";
import { fixTouchCachePath, readFixTouchCache, refreshFixTouchAfterFix } from "../core/fixtouch-cache.js";
import { commandIdentity } from "../core/fingerprint.js";
import { canonicalPath, loadMemoryChecked, type FailureRecord, type FixRecord } from "../core/memory-read.js";
import type { StoredCard } from "../desk/cards-record.js";
import { cardsFilePath } from "../listening/cards-path.js";
import { failurePayload, passPayload } from "./tool-result-hook-fixture.js";

const NOW = 1_700_000_120_000;
const FAILURE_TS = NOW - 60_000;
const CMD = "npm test";
const SIGNATURE = "TypeError: token undefined";
const FILES = ["src/session.ts", "src/token.ts"];
const CWD = "/app/packages/auth";
const COLLECT_OPTS = { now: NOW, rootFor: (cwd: string) => dirname(dirname(cwd)), platform: "linux" } as const;

function makeAttempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    failureId: "failure-1",
    ts: FAILURE_TS,
    cmd: CMD,
    outcome: "passed",
    sessionScoped: false,
    changes: { state: "observed", files: FILES, more: 0, cardId: "card-1", partial: false },
    ...overrides,
  };
}

function makeProblem(attempts: Attempt[], signature = [SIGNATURE]): ProblemEntry {
  return {
    problemId: "problem-1",
    key: "key-1",
    fingerprint: "aaaa000000000001",
    family: ["aaaa000000000001"],
    keyStrength: "output",
    cwd: CWD,
    firstSeenTs: FAILURE_TS,
    lastSeenTs: FAILURE_TS,
    signature,
    counts: { attempts: attempts.length, passed: 1, possible_pass: 0, same_failure: 0, different_failure: 0, no_later_run: 0, unknown: 0 },
    latestOutcome: "passed",
    attempts,
    historyMayStartEarlier: false,
  };
}

test("collects each observed path from a passed attempt with its repository and first signature line", () => {
  const problems = [makeProblem([makeAttempt({ outcomeTs: NOW - 1 })], [SIGNATURE, "stack trace"])];
  assert.deepEqual(collectFixTouchEntries(problems, COLLECT_OPTS), [
    { root: "/app", path: "src/session.ts", cmd: CMD, signature: SIGNATURE, ts: FAILURE_TS },
    { root: "/app", path: "src/token.ts", cmd: CMD, signature: SIGNATURE, ts: FAILURE_TS },
  ]);
});

test("excludes every outcome other than passed, even with observed paths", () => {
  const outcomes: AttemptOutcome[] = ["possible_pass", "same_failure", "different_failure", "no_later_run", "unknown"];
  const problems = [makeProblem(outcomes.map((outcome) => makeAttempt({ outcome })))];
  assert.deepEqual(collectFixTouchEntries(problems, COLLECT_OPTS), []);
});

test("excludes testimony and unknown changes from passed attempts", () => {
  const problems = [makeProblem([
    makeAttempt({ changes: { state: "testimony", files: FILES, rationaleId: "rationale-1" } }),
    makeAttempt({ changes: { state: "unknown" } }),
  ])];
  assert.deepEqual(collectFixTouchEntries(problems, COLLECT_OPTS), []);
});

test("keeps attempts exactly 30 days old and excludes earlier attempts", () => {
  const cutoff = NOW - 30 * 86_400_000;
  const problems = [makeProblem([
    makeAttempt({ ts: cutoff - 1, cmd: "npm run stale", outcomeTs: NOW - 1 }),
    makeAttempt({ ts: cutoff }),
  ])];
  assert.deepEqual(collectFixTouchEntries(problems, COLLECT_OPTS).map(({ ts }) => ts), [cutoff, cutoff]);
});

test("keeps duplicate paths newest first and uses an empty signature when none was stored", () => {
  const older = makeAttempt({
    changes: { state: "observed", files: ["src/session.ts"], more: 0, cardId: "card-1", partial: false },
  });
  const newer = makeAttempt({ ...older, failureId: "failure-2", ts: FAILURE_TS + 1, cmd: "npm run auth" });
  assert.deepEqual(collectFixTouchEntries([makeProblem([older, newer], [])], COLLECT_OPTS), [
    { root: "/app", path: "src/session.ts", cmd: "npm run auth", signature: "", ts: FAILURE_TS + 1 },
    { root: "/app", path: "src/session.ts", cmd: CMD, signature: "", ts: FAILURE_TS },
  ]);
});

function makeHome(t: TestContext): string {
  const temp = mkdtempSync(join(tmpdir(), "rocky-fixtouch-refresh-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  return temp;
}

function writeEvidence(home: string, repo: string, ts: number, files: string[]) {
  const repoDir = join(home, repo);
  const root = repoDir.replaceAll("\\", "/");
  const cwd = join(repoDir, "packages", "auth");
  mkdirSync(join(repoDir, ".git"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const identity = commandIdentity(CMD, { platform: process.platform });
  const command = {
    cwd, cmd: CMD, commandIdentity: identity.value, identityV: 1,
    identityReliable: identity.reliable, platform: process.platform,
  } as const;
  const failure: FailureRecord = {
    ...command, kind: "failure", id: `failure-${repo}`, ts, exitCode: 1,
    fingerprint: "aaaa000000000001", fingerprintV: 2, signature: [SIGNATURE], excerpt: SIGNATURE, origin: "run",
  };
  const fix: FixRecord = {
    ...command, kind: "fix", id: `fix-${repo}`, ts: ts + 10_000, failureIds: [failure.id],
  };
  const card: StoredCard = {
    v: 1, card_id: `card-${repo}`, rev: 1, root, session_id: "session-1", agent_id: "",
    started_ms: ts - 2_000, ended_ms: ts + 11_000, prompt: "Fix the failing test",
    blocks: files.map((path, index) => ({
      seq: index + 1, path, labels: [{ id: "body_changed" }], importance: "medium",
      quote: { text: "Edit detail", shared: false },
    })),
    flow: [
      { kind: "cmd", text: CMD, ok: false, dur_ms: 1_000, seqs: [], exit_code: 1, start_ms: ts - 1_000, end_ms: ts, cwd },
      { kind: "edit", text: "edit", ok: true, dur_ms: 1_000, seqs: files.map((_, index) => index + 1), start_ms: ts + 2_000, end_ms: ts + 3_000 },
      { kind: "cmd", text: CMD, ok: true, dur_ms: 1_000, seqs: [], exit_code: 0, start_ms: ts + 9_000, end_ms: fix.ts, cwd, desc: "Verify the fix" },
    ],
    flow_more: 0, coverage: { state: "full", reasons: [] },
  };
  const logPath = cardsFilePath(canonicalPath(repoDir), home);
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, `${JSON.stringify(card)}\n`, "utf8");
  writeFileSync(join(home, "memory.jsonl"), `${JSON.stringify(failure)}\n${JSON.stringify(fix)}\n`, { flag: "a" });
  return { root, fix };
}

test("rebuilds from memory and cards across repository roots using the supplied home", (t) => {
  const home = makeHome(t);
  writeFileSync(join(home, "fixtouch-on"), "");
  const first = writeEvidence(home, "auth", FAILURE_TS, FILES);
  const second = writeEvidence(home, "api", FAILURE_TS + 15_000, ["src/client.ts"]);

  assert.equal(rebuildFixTouchCache({ home, now: NOW }), true);
  assert.deepEqual(readFixTouchCache(fixTouchCachePath(home), NOW), {
    v: 1, builtAt: NOW, entries: [
      { root: second.root, path: "src/client.ts", cmd: CMD, signature: SIGNATURE, ts: FAILURE_TS + 15_000 },
      { root: first.root, path: "src/session.ts", cmd: CMD, signature: SIGNATURE, ts: FAILURE_TS },
      { root: first.root, path: "src/token.ts", cmd: CMD, signature: SIGNATURE, ts: FAILURE_TS },
    ],
  });
});

test("rebuilds observed paths even when desk tool text is disabled", (t) => {
  const home = makeHome(t);
  writeFileSync(join(home, "fixtouch-on"), "");
  const previousHome = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previousHome;
  });
  const { root } = writeEvidence(home, "auth", FAILURE_TS, FILES);
  writeFileSync(join(home, "desk", "tool-text-off"), "");

  assert.equal(rebuildFixTouchCache({ home, now: NOW }), true);
  assert.deepEqual(readFixTouchCache(fixTouchCachePath(home), NOW), {
    v: 1, builtAt: NOW, entries: [
      { root, path: "src/session.ts", cmd: CMD, signature: SIGNATURE, ts: FAILURE_TS },
      { root, path: "src/token.ts", cmd: CMD, signature: SIGNATURE, ts: FAILURE_TS },
    ],
  });
});

test("rebuild with no marker returns false without creating the derived directory", (t) => {
  const home = makeHome(t);
  writeEvidence(home, "auth", FAILURE_TS, FILES);

  assert.equal(rebuildFixTouchCache({ home, now: NOW }), false);
  assert.equal(existsSync(dirname(fixTouchCachePath(home))), false);
});

test("rebuild with no marker preserves existing cache bytes", (t) => {
  const home = makeHome(t);
  writeEvidence(home, "auth", FAILURE_TS, FILES);
  const file = fixTouchCachePath(home);
  const oldCache = Buffer.from(`{ "v": 1, "builtAt": ${NOW - 1}, "entries": [] }\r\n`);
  mkdirSync(dirname(file));
  writeFileSync(file, oldCache);

  assert.equal(rebuildFixTouchCache({ home, now: NOW }), false);
  assert.deepEqual(readFileSync(file), oldCache);
});

test("rebuild discards staged bytes if the marker disappears before publication", (t) => {
  const home = makeHome(t);
  writeEvidence(home, "auth", FAILURE_TS, FILES);
  const file = fixTouchCachePath(home);
  const marker = join(home, "fixtouch-on");
  const oldCache = Buffer.from(`{ "v": 1, "builtAt": ${NOW - 1}, "entries": [] }\r\n`);
  mkdirSync(dirname(file));
  writeFileSync(file, oldCache);
  writeFileSync(marker, "");

  const originalExists = fs.existsSync;
  const exists = t.mock.method(fs, "existsSync", (path: Parameters<typeof originalExists>[0]) => {
    if (path === marker && originalExists(`${file}.${process.pid}.tmp`)) unlinkSync(marker);
    return originalExists(path);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(rebuildFixTouchCache({ home, now: NOW }), false);
  } finally {
    exists.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(existsSync(marker), false);
  assert.deepEqual(readFileSync(file), oldCache);
  assert.deepEqual(readdirSync(dirname(file)), ["attempts-hot.json"]);
});

for (const [condition, writeMemory] of [
  ["the memory path is a directory", (path: string) => mkdirSync(path)],
  ["malformed records exceed the readable coverage allowance", (path: string) => writeFileSync(path, "invalid\n".repeat(4))],
] as const) {
  test(`preserves the existing cache bytes when ${condition}`, (t) => {
    const home = makeHome(t);
    writeFileSync(join(home, "fixtouch-on"), "");
    const file = fixTouchCachePath(home);
    const oldCache = Buffer.from(`{ "v": 1, "builtAt": ${NOW - 1}, "entries": [] }\r\n`);
    mkdirSync(dirname(file));
    writeFileSync(file, oldCache);
    writeMemory(join(home, "memory.jsonl"));

    assert.equal(rebuildFixTouchCache({ home, now: NOW }), false);
    assert.deepEqual(readFileSync(file), oldCache);
  });
}

test("refreshes only after a fix write with the opt-in marker present", async (t) => {
  const home = makeHome(t);
  const { fix } = writeEvidence(home, "auth", FAILURE_TS, FILES);
  const file = fixTouchCachePath(home);

  await refreshFixTouchAfterFix(fix, { home, now: NOW });
  assert.equal(readFixTouchCache(file, NOW), undefined);

  writeFileSync(join(home, "fixtouch-on"), "");
  await refreshFixTouchAfterFix(undefined, { home, now: NOW });
  assert.equal(readFixTouchCache(file, NOW), undefined);

  await refreshFixTouchAfterFix(fix, { home, now: NOW });
  assert.equal(readFixTouchCache(file, NOW)?.entries.length, 2);
});

test("refresh skips the write when the marker is removed during import", async (t) => {
  const home = makeHome(t);
  const { fix } = writeEvidence(home, "auth", FAILURE_TS, FILES);
  const marker = join(home, "fixtouch-on");
  writeFileSync(marker, "");

  const refresh = refreshFixTouchAfterFix(fix, { home, now: NOW });
  unlinkSync(marker);
  await refresh;

  assert.equal(existsSync(dirname(fixTouchCachePath(home))), false);
});

test("fix-touch writes are reachable only through the confirmed fix call sites", () => {
  const sourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));
  const calls = new Map([
    ["rebuildFixTouchCache", [] as string[]],
    ["writeFixTouchCache", [] as string[]],
    ["refreshFixTouchAfterFix", [] as string[]],
  ]);

  function scan(dir: string): void {
    for (const entry of readdirSync(join(sourceRoot, dir), { withFileTypes: true })) {
      const file = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (file !== "test") scan(file);
        continue;
      }
      if (!file.endsWith(".ts")) continue;
      const source = ts.createSourceFile(file, readFileSync(join(sourceRoot, file), "utf8"), ts.ScriptTarget.Latest);
      function visit(node: ts.Node): void {
        if (ts.isCallExpression(node)) {
          const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
          if (ts.isIdentifier(callee)) {
            calls.get(callee.text)?.push(file);
            if (callee.text === "refreshFixTouchAfterFix") {
              const fix = node.arguments[0];
              assert.ok(fix && ts.isPropertyAccessExpression(fix) && fix.name.text === "fix", file);
            }
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  scan("");

  assert.deepEqual(calls.get("rebuildFixTouchCache"), ["core/fixtouch-cache.ts"]);
  assert.deepEqual(calls.get("writeFixTouchCache"), ["commands/fixtouch-refresh.ts"]);
  assert.deepEqual(calls.get("refreshFixTouchAfterFix")?.sort(), [
    "commands/hook.ts", "commands/run.ts", "commands/tool-result-hook.ts",
  ]);
});

for (const lane of ["shell hook", "tool-result hook"] as const) {
  for (const { name, optIn, cmd, outcome } of [
    { name: "refreshes the cache for a confirmed fix with opt-in", optIn: true, cmd: CMD, outcome: "fix" },
    { name: "leaves the derived directory absent without opt-in", optIn: false, cmd: CMD, outcome: "fix" },
    { name: "leaves the cache absent for a possible association", optIn: true, cmd: "npm run lint", outcome: "association" },
  ] as const) {
    test(`${lane} ${name}`, async (t) => {
      const home = makeHome(t);
      const cwd = join(home, "repo");
      mkdirSync(cwd);
      const previousHome = process.env.ROCKY_HOME;
      process.env.ROCKY_HOME = home;
      t.after(() => {
        if (previousHome === undefined) delete process.env.ROCKY_HOME;
        else process.env.ROCKY_HOME = previousHome;
      });
      if (optIn) writeFileSync(join(home, "fixtouch-on"), "");

      const cache = fixTouchCachePath(home);
      if (lane === "shell hook") {
        assert.equal(hookFail(CMD, 1, cwd), 0);
      } else {
        assert.equal(await toolResultHook(Buffer.from(failurePayload({ cwd }))), "{}");
      }
      assert.equal(existsSync(join(home, "pending")), true);
      assert.equal(existsSync(cache), false);

      if (lane === "shell hook") {
        assert.equal(await hookSuccess(cmd, cwd), 0);
      } else {
        const payload = passPayload({ cwd, tool_input: { command: cmd } });
        assert.equal(await toolResultHook(Buffer.from(payload)), "{}");
      }

      const { records } = loadMemoryChecked(join(home, "memory.jsonl"));
      assert.deepEqual(records.map((record) => record.kind), ["failure", outcome]);
      if (optIn) {
        assert.equal(existsSync(cache), outcome === "fix");
      } else {
        assert.equal(existsSync(dirname(cache)), false);
      }
    });
  }
}
