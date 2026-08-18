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

test("briefCommand canonicalizes cwd so a native-separator memory record still matches the git-resolved (forward-slash) root", async () => {
  const dir = makeRepo();
  const home = mkdtempSync(join(tmpdir(), "rocky-home-"));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
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
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  }
});

test("briefCommand scopes a --since <git-ref> memory window to the ref's own commit time, not epoch 0", async () => {
  const { dir, firstSha, firstIso } = makeDatedRepo();
  const home = mkdtempSync(join(tmpdir(), "rocky-home-"));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
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
