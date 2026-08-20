import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { briefCommand, parseBriefArgs } from "../commands/brief.js";
import { loadMemoryChecked } from "../core/memory-read.js";
import { readState } from "../core/brief-state.js";
import { recordWatchFailure } from "../core/memory.js";

/**
 * briefCommand now runs captureRationales() on every successful call (Task
 * 17). Left unisolated, that would scan this host's real Claude Code /dsh
 * session logs and could write unrelated `rationale` records into the
 * test's fresh ROCKY_HOME memory file, making assertions about exactly
 * which kinds got recorded non-deterministic. Point both adapters at
 * paths that cannot exist — same guard sessions-command.test.ts uses for
 * the same reason.
 */
function isolateAgentLogEnv(home: string): { restore: () => void } {
  const previous = {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    DSH_SESSION_JSONL: process.env.DSH_SESSION_JSONL,
  };
  process.env.CLAUDE_CONFIG_DIR = join(home, "no-claude-config-here");
  process.env.DSH_SESSION_JSONL = join(home, "no-dsh-log-here.jsonl.zstd");
  return {
    restore: () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key as keyof typeof previous];
        else process.env[key as keyof typeof previous] = value;
      }
    },
  };
}

function makeRepo(): string {
  // realpathSync.native resolves symlinks/short-names in the OS temp dir
  // (macOS /var -> /private/var; Windows 8.3 short names on CI runners) so
  // this path stays identical to what `git rev-parse --show-toplevel`
  // reports. Without it, path-identity comparisons that rely on both sides
  // pointing at the same filesystem path can fail in CI even though they
  // pass locally.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "rocky-brief-")));
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  };
  git("init");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  mkdirSync(join(dir, "src", "payment"), { recursive: true });
  writeFileSync(join(dir, "src", "payment", "retry.ts"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-m", "feat: add retry worker");
  return dir;
}

// Two commits with explicit, far-apart author/committer dates (not wall-clock
// timing), so the ref-window test below has a deterministic gap to seed
// memory records into rather than racing real commit timestamps.
function makeDatedRepo(): { dir: string; firstSha: string; firstIso: string } {
  // See makeRepo() above: realpath the temp dir so it matches git's resolved
  // toplevel path in CI environments with symlinked/short-named temp dirs.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "rocky-brief-since-")));
  const git = (args: string[], env?: NodeJS.ProcessEnv): void => {
    execFileSync("git", ["-C", dir, ...args], { stdio: "ignore", env: env === undefined ? process.env : { ...process.env, ...env } });
  };
  git(["init"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "t"]);

  const firstIso = "2024-01-01T00:00:00+00:00";
  const secondIso = "2024-01-02T00:00:00+00:00";

  writeFileSync(join(dir, "a.txt"), "one\n");
  git(["add", "."]);
  git(["commit", "-m", "feat: first"], { GIT_AUTHOR_DATE: firstIso, GIT_COMMITTER_DATE: firstIso });
  const firstSha = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  writeFileSync(join(dir, "b.txt"), "two\n");
  git(["add", "."]);
  git(["commit", "-m", "feat: second"], { GIT_AUTHOR_DATE: secondIso, GIT_COMMITTER_DATE: secondIso });

  return { dir, firstSha, firstIso };
}

test("parseBriefArgs handles --since, --quiet, --ai and rejects strays", () => {
  assert.deepEqual(parseBriefArgs([]), { quiet: false, ai: false });
  assert.deepEqual(parseBriefArgs(["--since", "24h", "--quiet"]), { since: "24h", quiet: true, ai: false });
  assert.deepEqual(parseBriefArgs(["--ai"]), { quiet: false, ai: true });
  assert.throws(() => parseBriefArgs(["--since"]));
  assert.throws(() => parseBriefArgs(["stray"]));
});

test("briefCommand reports window, records brief_run and invariant_touch, updates state", async () => {
  const dir = makeRepo();
  mkdirSync(join(dir, ".rocky"), { recursive: true });
  writeFileSync(join(dir, ".rocky", "invariants.md"), [
    "Invariant: payment may commit at most once",
    "Guarded by: src/payment/**",
    "",
  ].join("\n"));
  const home = mkdtempSync(join(tmpdir(), "rocky-home-"));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  const agentLogs = isolateAgentLogEnv(home);
  try {
    const code = await briefCommand(["--since", "1d", "--quiet"], dir);
    assert.equal(code, 0);
    const memory = loadMemoryChecked(join(home, "memory.jsonl"));
    const kinds = memory.records.map((record) => record.kind).sort();
    assert.deepEqual(kinds, ["brief_run", "invariant_touch"]);
    const touch = memory.records.find((record) => record.kind === "invariant_touch");
    assert.ok(touch !== undefined && touch.kind === "invariant_touch");
    assert.equal(touch.path, "src/payment/retry.ts");
    const state = readState(join(home, "state.json"));
    assert.ok(state.lastBriefTs !== undefined && state.lastBriefTs > 0);
  } finally {
    agentLogs.restore();
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  }
});

// Intercepts console.log specifically (what briefCommand's report uses) rather
// than process.stdout.write: the test runner's own reporter writes checkmarks
// via process.stdout.write on an async tick, so swapping that out here can
// swallow an unrelated test's result line. console.log never collides with it.
async function captureStdout(run: () => Promise<number>): Promise<{ code: number; stdout: string }> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = ((...args: unknown[]) => { lines.push(args.map(String).join(" ")); }) as typeof console.log;
  try {
    return { code: await run(), stdout: lines.join("\n") };
  } finally {
    console.log = originalLog;
  }
}

/**
 * Same console.log interception as captureStdout, plus process.stderr.write
 * interception for the "why" annotation and "repeated concepts" section,
 * which go through detail()/heading() (stderr), not console.log.
 */
async function captureStdio(run: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  const originalLog = console.log;
  const originalStderr = process.stderr.write;
  const lines: string[] = [];
  let stderr = "";
  console.log = ((...args: unknown[]) => { lines.push(args.map(String).join(" ")); }) as typeof console.log;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: await run(), stdout: lines.join("\n"), stderr };
  } finally {
    console.log = originalLog;
    process.stderr.write = originalStderr;
  }
}

test("briefCommand canonicalizes cwd so a native-separator memory record still matches the git-resolved (forward-slash) root", async () => {
  const dir = makeRepo();
  const home = mkdtempSync(join(tmpdir(), "rocky-home-"));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  const agentLogs = isolateAgentLogEnv(home);
  try {
    // recordWatchFailure is the real writer that accepts an explicit cwd; on
    // Windows `dir` (from mkdtempSync/join) uses backslashes, exactly like
    // process.cwd()-derived record.cwd would, while briefCommand resolves
    // `root` from `git rev-parse --show-toplevel`, which always answers with
    // forward slashes. Without canonicalization on both sides this record
    // would never match `root` and block 3 would render "none remembered".
    recordWatchFailure("npm test", 1, "Error: boom\nassertion failed", dir);
    const { code, stdout } = await captureStdout(() => briefCommand(["--since", "1d", "--quiet"], dir));
    assert.equal(code, 0);
    assert.match(stdout, /failure: npm test/);
    assert.doesNotMatch(stdout, /none remembered/);
  } finally {
    agentLogs.restore();
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  }
});

test("briefCommand scopes a --since <git-ref> memory window to the ref's own commit time, not epoch 0", async () => {
  const { dir, firstSha, firstIso } = makeDatedRepo();
  const home = mkdtempSync(join(tmpdir(), "rocky-home-"));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  const agentLogs = isolateAgentLogEnv(home);
  try {
    const firstCommitTs = Date.parse(firstIso);
    // After the first commit, before the second: should surface in block 3
    // once --since resolves to the first commit's own timestamp.
    const inWindow = {
      kind: "failure", id: "since-in-window", ts: firstCommitTs + 3_600_000, cwd: dir,
      cmd: "npm test since-in-window", exitCode: 1, fingerprint: "fp-since-in-window",
      signature: ["boom"], excerpt: "boom",
    };
    // Far before the first commit: with the old unscoped sinceTs of 0 this
    // would leak into block 3 too; it must not once the ref is resolved.
    const beforeFirstCommit = {
      kind: "failure", id: "since-before-first", ts: 1000, cwd: dir,
      cmd: "npm test since-before-first", exitCode: 1, fingerprint: "fp-since-before-first",
      signature: ["ancient boom"], excerpt: "ancient boom",
    };
    writeFileSync(
      join(home, "memory.jsonl"),
      `${JSON.stringify(beforeFirstCommit)}\n${JSON.stringify(inWindow)}\n`,
      "utf8",
    );

    const { code, stdout } = await captureStdout(() => briefCommand(["--since", firstSha, "--quiet"], dir));
    assert.equal(code, 0);
    assert.match(stdout, /failure: npm test since-in-window/);
    assert.doesNotMatch(stdout, /since-before-first/);
  } finally {
    agentLogs.restore();
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  }
});

test("briefCommand exits 1 outside a git repo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rocky-nogit-"));
  const home = mkdtempSync(join(tmpdir(), "rocky-home-"));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    assert.equal(await briefCommand([], dir), 1);
  } finally {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  }
});

test("briefCommand annotates a printed failure with its linked rationale, and prints no repeated-concepts section for a single hit", async () => {
  const dir = makeRepo();
  const home = mkdtempSync(join(tmpdir(), "rocky-home-"));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  const agentLogs = isolateAgentLogEnv(home);
  try {
    const now = Date.now();
    const failure = {
      kind: "failure", id: "why-f1", ts: now - 1000, cwd: dir,
      cmd: "npm test", exitCode: 1, fingerprint: "fp-why-f1",
      signature: ["boom"], excerpt: "boom",
    };
    // Linked by id (links.failureId), not by guessing at nearby text.
    const rationale = {
      kind: "rationale", id: "why-r1", ts: now - 500, v: 1, cwd: dir,
      agent: "human", rationale_fidelity: "summary", source: "human",
      excerpt: "second attempt double-charged the customer",
      links: { failureId: "why-f1" },
    };
    writeFileSync(join(home, "memory.jsonl"), `${JSON.stringify(failure)}\n${JSON.stringify(rationale)}\n`, "utf8");

    const { code, stdout, stderr } = await captureStdio(() => briefCommand(["--since", "1d", "--quiet"], dir));
    assert.equal(code, 0);
    assert.match(stdout, /failure: npm test/);
    assert.match(stderr, /why: second attempt double-charged the customer \(you said\)/);
    // Only one concept-bearing record exists: the repeated-concepts section
    // (count >= 2) must not appear for it.
    assert.doesNotMatch(stderr, /repeated concepts/);
  } finally {
    agentLogs.restore();
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  }
});

test("briefCommand's why annotation prefers the highest-fidelity linked rationale over a newer, lower-fidelity one", async () => {
  const dir = makeRepo();
  const home = mkdtempSync(join(tmpdir(), "rocky-home-"));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  const agentLogs = isolateAgentLogEnv(home);
  try {
    const now = Date.now();
    const failure = {
      kind: "failure", id: "fidelity-f1", ts: now - 2000, cwd: dir,
      cmd: "npm test", exitCode: 1, fingerprint: "fp-fidelity-f1",
      signature: ["boom"], excerpt: "boom",
    };
    // Older but raw fidelity: must still win display over a newer,
    // lower-fidelity capture of the same failure. Fidelity has no
    // correlation with recency — the four capture lanes fire independently
    // and asynchronously (design spec section 4).
    const rawOlder = {
      kind: "rationale", id: "fidelity-r-raw", ts: now - 1500, v: 1, cwd: dir,
      agent: "human", rationale_fidelity: "raw", source: "log-thinking",
      excerpt: "raw thinking capture, older but higher fidelity",
      links: { failureId: "fidelity-f1" },
    };
    const summaryNewer = {
      kind: "rationale", id: "fidelity-r-summary", ts: now - 100, v: 1, cwd: dir,
      agent: "human", rationale_fidelity: "summary", source: "notify",
      excerpt: "summary capture, newer but lower fidelity",
      links: { failureId: "fidelity-f1" },
    };
    // Written newer-first so a plain "last one wins" bug would also fail this.
    writeFileSync(
      join(home, "memory.jsonl"),
      [failure, summaryNewer, rawOlder].map((record) => JSON.stringify(record)).join("\n") + "\n",
      "utf8",
    );

    const { code, stderr } = await captureStdio(() => briefCommand(["--since", "1d", "--quiet"], dir));
    assert.equal(code, 0);
    assert.match(stderr, /why: raw thinking capture, older but higher fidelity \(heard from thinking\)/);
    assert.doesNotMatch(stderr, /summary capture, newer but lower fidelity/);
  } finally {
    agentLogs.restore();
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  }
});

test("briefCommand's why annotation truncates a long rationale excerpt at a UTF-8 character boundary, never mid-character", async () => {
  const dir = makeRepo();
  const home = mkdtempSync(join(tmpdir(), "rocky-home-"));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  const agentLogs = isolateAgentLogEnv(home);
  try {
    const now = Date.now();
    const failure = {
      kind: "failure", id: "trunc-f1", ts: now - 1000, cwd: dir,
      cmd: "npm test", exitCode: 1, fingerprint: "fp-trunc-f1",
      signature: ["boom"], excerpt: "boom",
    };
    // 127 ASCII bytes, then a 3-byte UTF-8 character (euro sign, U+20AC)
    // straddling the 128-byte truncation boundary: 127 + 3 = 130 > 128, so
    // a boundary-respecting truncator must drop the whole character rather
    // than split it. Text after it proves truncation actually fires — an
    // unbounded implementation would print this tail too.
    const longExcerpt = `${"a".repeat(127)}€ and a tail that must never reach the terminal`;
    const rationale = {
      kind: "rationale", id: "trunc-r1", ts: now - 500, v: 1, cwd: dir,
      agent: "human", rationale_fidelity: "raw", source: "human",
      excerpt: longExcerpt,
      links: { failureId: "trunc-f1" },
    };
    writeFileSync(join(home, "memory.jsonl"), `${JSON.stringify(failure)}\n${JSON.stringify(rationale)}\n`, "utf8");

    const { code, stderr } = await captureStdio(() => briefCommand(["--since", "1d", "--quiet"], dir));
    assert.equal(code, 0);
    // Exactly the 127-byte ASCII prefix; the euro sign dropped whole, not
    // split, and the tail never reached the terminal.
    assert.match(stderr, new RegExp(`why: ${"a".repeat(127)} \\(you said\\)`));
    assert.doesNotMatch(stderr, /€/);
    assert.doesNotMatch(stderr, /tail that must never reach/);
    assert.doesNotMatch(stderr, /�/); // no replacement character from a split multi-byte sequence
  } finally {
    agentLogs.restore();
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  }
});

test("briefCommand prints a repeated concepts section when memory holds the same concept twice or more in window", async () => {
  const dir = makeRepo();
  const home = mkdtempSync(join(tmpdir(), "rocky-home-"));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  const agentLogs = isolateAgentLogEnv(home);
  try {
    const now = Date.now();
    const triple = (id: string, ts: number, text: string) => ({
      kind: "triple", id, ts, cwd: dir, schemaV: 1, agent: "claude-code", origin: "agent-hook",
      intent: { text }, mechanism: { files: [], truncatedFiles: 0 },
    });
    writeFileSync(
      join(home, "memory.jsonl"),
      [
        triple("rc-t1", now - 2000, "idempotent retry, no duplicate commit"),
        triple("rc-t2", now - 1000, "idempotency on webhook replay"),
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
      "utf8",
    );

    const { code, stderr } = await captureStdio(() => briefCommand(["--since", "1d", "--quiet"], dir));
    assert.equal(code, 0);
    assert.match(stderr, /repeated concepts/);
    assert.match(stderr, /idempotency heard 2 times\. same fundamental, same\./);
  } finally {
    agentLogs.restore();
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  }
});
