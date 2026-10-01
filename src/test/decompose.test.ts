import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DECOMPOSE_BLANK_PROMPT,
  DECOMPOSE_MAX_FILES,
  DECOMPOSE_NUDGE,
  DECOMPOSE_SAY_BLANK,
  DECOMPOSE_SAY_FILLED,
  decomposeFilesFromDiff,
  decomposeNudgeLine,
  renderDecomposeCard,
} from "../core/decompose.js";
import { check, parseDecomposeRequest } from "../commands/check.js";
import { briefCommand, parseBriefArgs } from "../commands/brief.js";
import { validateRockyPhrase } from "../ui/phrases.js";

/**
 * briefCommand runs captureRationales() on every successful call. Left
 * unisolated, that would scan this host's real agent logs and could write
 * unrelated records into the test's fresh ROCKY_HOME, making assertions
 * non-deterministic. Same guard brief-command.test.ts uses.
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
  // realpathSync.native keeps this identical to `git rev-parse
  // --show-toplevel` in CI temp dirs with symlinks/short names.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "rocky-decompose-")));
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  };
  git("init");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "src-payment-retry.ts"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-m", "feat: add retry worker");
  return dir;
}

async function captureStderr(run: () => Promise<number>): Promise<{ code: number; stderr: string }> {
  const originalStderr = process.stderr.write;
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: await run(), stderr };
  } finally {
    process.stderr.write = originalStderr;
  }
}

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

test("decompose card names staged files in 3 numbered lines", () => {
  const card = renderDecomposeCard(["src/payment/retry.ts"]);
  const text = card.join("\n");
  assert.match(text, /^1\. behavior:/m);
  assert.match(text, /^2\. state:/m);
  assert.match(text, /^3\. verify:/m);
  assert.match(text, /src\/payment\/retry\.ts/);
  assert.doesNotMatch(text, /\?/);
});

test("empty file list renders the blank template with a question-style prompt", () => {
  for (const card of [renderDecomposeCard([]), renderDecomposeCard(["  ", "/dev/null"])]) {
    const text = card.join("\n");
    assert.match(text, /^1\. behavior:/m);
    assert.match(text, /^2\. state:/m);
    assert.match(text, /^3\. verify:/m);
    assert.match(text, /<one line what changes>/);
    assert.match(text, /, question$/m);
    assert.doesNotMatch(text, /\?/);
  }
});

test("card bounds long file lists and dedupes repeats", () => {
  const files = ["b.ts", "a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts"];
  const text = renderDecomposeCard(files).join("\n");
  assert.match(text, /a\.ts/);
  assert.match(text, /and 2 more/);
  assert.doesNotMatch(text, /\?/);
  assert.equal(DECOMPOSE_MAX_FILES, 5);
});

test("diff parsing extracts header names, never a dev-null entry, never throws", () => {
  const diff = [
    "diff --git a/src/old.ts b/src/new.ts",
    "--- a/src/old.ts",
    "+++ b/src/new.ts",
    "@@ -1 +1 @@",
    "-const a = 1;",
    "+const a = 2;",
    "diff --git a/gone.ts b/gone.ts",
    "--- a/gone.ts",
    "+++ /dev/null",
  ].join("\n");
  // A deleted path stays named (it is part of the change); the /dev/null
  // marker itself must never become a file entry.
  assert.deepEqual(decomposeFilesFromDiff(diff), ["src/new.ts", "gone.ts"]);
  assert.ok(!decomposeFilesFromDiff(diff).some((file) => file.includes("dev/null")));
  assert.deepEqual(decomposeFilesFromDiff(""), []);
  assert.deepEqual(decomposeFilesFromDiff("not a diff\n"), []);
  assert.deepEqual(decomposeFilesFromDiff(undefined), []);
});

test("nudge and voice lines follow Rocky voice rules, never a question mark", () => {
  assert.equal(typeof decomposeNudgeLine(), "string");
  for (const line of [DECOMPOSE_NUDGE, DECOMPOSE_BLANK_PROMPT, DECOMPOSE_SAY_BLANK, DECOMPOSE_SAY_FILLED]) {
    assert.deepEqual(validateRockyPhrase(line), [], line);
  }
  assert.match(DECOMPOSE_NUDGE, /, question$/);
});

test("parseDecomposeRequest splits the flag from the rest", () => {
  assert.deepEqual(parseDecomposeRequest([]), { decompose: false, rest: [] });
  assert.deepEqual(parseDecomposeRequest(["--decompose", "--quiet"]), { decompose: true, rest: ["--quiet"] });
  assert.deepEqual(parseDecomposeRequest(["--offline"]), { decompose: false, rest: ["--offline"] });
  assert.throws(() => parseDecomposeRequest(["--decompose", "--decompose"]), /unexpected option/);
});

test("check --prompt and --decompose conflict with exit 2", async () => {
  assert.equal(await check(["--prompt", "fix it", "--decompose"]), 2);
  assert.equal(await check(["--decompose", "--offline"]), 2, "conflicting modes refuse");
  assert.equal(await check(["--decompose", "--decompose", "--quiet"]), 2, "repeated flag refuses");
});

test("check --decompose is advisory: exit 0 with 3 numbered detail lines", async () => {
  const { code, stderr } = await captureStderr(() => check(["--decompose", "--quiet"]));
  assert.equal(code, 0);
  assert.match(stderr, /^1\. behavior:/m);
  assert.match(stderr, /^2\. state:/m);
  assert.match(stderr, /^3\. verify:/m);
  assert.doesNotMatch(stderr, /\?/);
});

test("check --decompose --help prints usage and checks nothing", async () => {
  const { code, stderr } = await captureStderr(() => check(["--decompose", "--help"]));
  assert.equal(code, 0);
  assert.match(stderr, /usage: rocky check --decompose/);
});

test("brief --decompose appends a checklist naming window files", async () => {
  const dir = makeRepo();
  const home = mkdtempSync(join(tmpdir(), "rocky-home-"));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  const agentLogs = isolateAgentLogEnv(home);
  try {
    const { code, stdout } = await captureStdout(
      () => briefCommand(["--since", "1d", "--quiet", "--decompose"], dir),
    );
    assert.equal(code, 0);
    assert.match(stdout, /^1\. behavior:/m);
    assert.match(stdout, /^2\. state:/m);
    assert.match(stdout, /^3\. verify:/m);
    assert.match(stdout, /src-payment-retry\.ts/);
    assert.doesNotMatch(stdout, /\?/);
  } finally {
    agentLogs.restore();
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  }
});

test("brief without --decompose prints no checklist", async () => {
  const dir = makeRepo();
  const home = mkdtempSync(join(tmpdir(), "rocky-home-"));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  const agentLogs = isolateAgentLogEnv(home);
  try {
    const { code, stdout } = await captureStdout(() => briefCommand(["--since", "1d", "--quiet"], dir));
    assert.equal(code, 0);
    assert.doesNotMatch(stdout, /^1\. behavior:/m);
  } finally {
    agentLogs.restore();
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  }
});

test("brief --decompose twice refuses with exit 2", async () => {
  const dir = makeRepo();
  const home = mkdtempSync(join(tmpdir(), "rocky-home-"));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    assert.equal(await briefCommand(["--decompose", "--decompose"], dir), 2);
  } finally {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  }
});

test("brief parses --decompose without changing other flags", () => {
  assert.deepEqual(parseBriefArgs(["--decompose"]), { quiet: false, ai: false, decompose: true });
  assert.deepEqual(
    parseBriefArgs(["--since", "24h", "--decompose", "--quiet"]),
    { since: "24h", quiet: true, ai: false, decompose: true },
  );
});
