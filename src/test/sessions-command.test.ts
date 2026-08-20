import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { groupSessions, sessionsCommand } from "../commands/sessions.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import type { MemoryRecord } from "../core/memory-read.js";

const rec = (kind: string, id: string, ts: number, cwd = "/p"): MemoryRecord =>
  ({ kind, id, ts, cwd } as unknown as MemoryRecord);

test("splits on 30min gap and cwd, counts kinds, newest-first", () => {
  const H = 3600_000;
  const groups = groupSessions([
    rec("failure", "f1", 1 * H), rec("fix", "x1", 1 * H + 60_000),
    rec("failure", "f2", 3 * H),                     // gap > 30min -> new session
    rec("failure", "f3", 3 * H + 60_000, "/other"),  // different cwd -> own session
  ]);
  assert.equal(groups.length, 3);
  // "/other"'s single record is the newest of all four, so it leads.
  assert.equal(groups[0].startTs, 3 * H + 60_000);
  assert.equal(groups[0].cwd, "/other");
  assert.equal(groups[0].index, 1);
  assert.equal(groups[1].startTs, 3 * H);
  assert.equal(groups[1].cwd, "/p");
  assert.equal(groups[1].index, 2);
  const first = groups.find((g) => g.cwd === "/p" && g.startTs === 1 * H)!;
  assert.deepEqual(first.counts, { failures: 1, fixes: 1, triples: 0, rationales: 0 });
  assert.equal(first.index, 3);
});

test("groupSessions breaks a startTs tie by cwd ascending, deterministically (ruling 2)", () => {
  const H = 3600_000;
  const groups = groupSessions([
    rec("failure", "a1", 5 * H, "/zzz"),
    rec("failure", "b1", 5 * H, "/aaa"),
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].cwd, "/aaa");
  assert.equal(groups[0].index, 1);
  assert.equal(groups[1].cwd, "/zzz");
  assert.equal(groups[1].index, 2);
});

test("agents are distinct triple/rationale agents; association ignored for counts; alias has no cwd and is excluded", () => {
  const H = 3600_000;
  const records: MemoryRecord[] = [
    { kind: "triple", id: "t1", ts: 1 * H, cwd: "/p", agent: "claude-code" } as unknown as MemoryRecord,
    { kind: "triple", id: "t2", ts: 1 * H + 60_000, cwd: "/p", agent: "codex" } as unknown as MemoryRecord,
    { kind: "rationale", id: "r1", ts: 1 * H + 120_000, cwd: "/p", agent: "claude-code" } as unknown as MemoryRecord,
    { kind: "rationale", id: "r2", ts: 1 * H + 180_000, cwd: "/p", agent: "human" } as unknown as MemoryRecord,
    { kind: "association", id: "a1", ts: 1 * H + 240_000, cwd: "/p" } as unknown as MemoryRecord,
    { kind: "alias", id: "al1", ts: 1 * H + 300_000 } as unknown as MemoryRecord, // no cwd at all
  ];
  const groups = groupSessions(records);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].counts, { failures: 0, fixes: 0, triples: 2, rationales: 2 });
  assert.deepEqual(groups[0].agents, ["claude-code", "codex", "human"]);
});

test("groupSessions never throws on an empty record set", () => {
  assert.deepEqual(groupSessions([]), []);
});

function captureStderr(run: () => number): { code: number; stderr: string } {
  const originalStderr = process.stderr.write;
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: run(), stderr };
  } finally {
    process.stderr.write = originalStderr;
  }
}

/** Isolate a fresh ROCKY_HOME and, since the no-arg path runs captureRationales,
 * point the agent-log adapters at directories/files that do not exist so the
 * listing test's memory fixture is never polluted by this host's real logs. */
function isolatedHome(prefix: string): { home: string; restore: () => void } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const previous = {
    ROCKY_HOME: process.env.ROCKY_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    DSH_SESSION_JSONL: process.env.DSH_SESSION_JSONL,
  };
  process.env.ROCKY_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = join(home, "no-claude-config-here");
  process.env.DSH_SESSION_JSONL = join(home, "no-dsh-log-here.jsonl.zstd");
  return {
    home,
    restore: () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key as keyof typeof previous];
        else process.env[key as keyof typeof previous] = value;
      }
    },
  };
}

function writeMemoryFixture(home: string, records: readonly Record<string, unknown>[]): void {
  const paths = resolveRockyPaths({ ROCKY_HOME: home });
  writeFileSync(paths.memory, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

const BASE_TS = 2_000_000_000;
const CWD = "C:/work/proj";

function oneSessionFixture(): Record<string, unknown>[] {
  return [
    {
      kind: "failure", id: "f1", ts: BASE_TS, cwd: CWD, cmd: "npm test", exitCode: 1,
      fingerprint: "abc123", signature: ["Error: boom"], excerpt: "Error: boom\n    at x",
    },
    { kind: "fix", id: "x1", ts: BASE_TS + 1000, cwd: CWD, cmd: "npm test -- --fix", failureIds: ["f1"] },
    {
      kind: "triple", id: "t1", ts: BASE_TS + 2000, cwd: CWD, schemaV: 1, agent: "claude-code",
      origin: "agent-hook", mechanism: { files: [], truncatedFiles: 0 }, intent: { text: "fix payment retry loop" },
    },
    {
      kind: "rationale", id: "r1", ts: BASE_TS + 3000, v: 1, cwd: CWD, agent: "claude-code",
      rationale_fidelity: "summary", source: "log-thinking", excerpt: "queue timeout because retry storm",
    },
    {
      kind: "invariant_touch", id: "i1", ts: BASE_TS + 4000, v: 1, cwd: CWD,
      invariant: "payment may commit at most once", path: "src/payment/retry.ts",
    },
  ];
}

test("sessionsCommand numeric arg prints chronological detail lines per kind", () => {
  const { home, restore } = isolatedHome("rocky-sessions-detail-");
  try {
    writeMemoryFixture(home, oneSessionFixture());
    const { code, stderr } = captureStderr(() => sessionsCommand(["1"]));
    assert.equal(code, 0);
    assert.match(stderr, /Error: boom/);
    assert.match(stderr, /npm test -- --fix/);
    assert.match(stderr, /fixed 1 failure/);
    assert.match(stderr, /fix payment retry loop/);
    assert.match(stderr, /heard from thinking: queue timeout because retry storm/);
    assert.match(stderr, /payment may commit at most once/);
    // chronological: failure line precedes fix precedes triple precedes rationale precedes invariant
    const at = (needle: string) => stderr.indexOf(needle);
    assert.ok(at("Error: boom") < at("npm test -- --fix"));
    assert.ok(at("npm test -- --fix") < at("fix payment retry loop"));
    assert.ok(at("fix payment retry loop") < at("heard from thinking"));
    assert.ok(at("heard from thinking") < at("payment may commit at most once"));
  } finally {
    restore();
  }
});

test("sessionsCommand refuses an unknown index and names how many sessions rocky counts", () => {
  const { home, restore } = isolatedHome("rocky-sessions-unknown-");
  try {
    writeMemoryFixture(home, oneSessionFixture());
    const { code, stderr } = captureStderr(() => sessionsCommand(["99"]));
    assert.equal(code, 1);
    assert.match(stderr, /session not heard\. rocky counts 1 sessions, question/);
  } finally {
    restore();
  }
});

test("sessionsCommand unknown index against empty memory counts zero sessions", () => {
  const { restore } = isolatedHome("rocky-sessions-empty-");
  try {
    const { code, stderr } = captureStderr(() => sessionsCommand(["1"]));
    assert.equal(code, 1);
    assert.match(stderr, /session not heard\. rocky counts 0 sessions, question/);
  } finally {
    restore();
  }
});

test("sessionsCommand with no args lists sessions newest-first with a heuristic disclosure", () => {
  const { home, restore } = isolatedHome("rocky-sessions-list-");
  try {
    const H = 3600_000;
    writeMemoryFixture(home, [
      ...oneSessionFixture(),
      {
        kind: "failure", id: "f2", ts: BASE_TS + 5 * H, cwd: "C:/work/other", cmd: "cargo build", exitCode: 1,
        fingerprint: "def456", signature: ["error[E0433]"], excerpt: "error[E0433]: unresolved import",
      },
    ]);
    const { code, stderr } = captureStderr(() => sessionsCommand([]));
    assert.equal(code, 0);
    assert.match(stderr, /\[1\].*other/);
    assert.match(stderr, /\[2\].*proj/);
    assert.match(stderr, /1 failure, 1 fix, 1 rationale/);
    assert.match(stderr, /sessions derived from memory\. boundaries heuristic, not exact\./);
  } finally {
    restore();
  }
});

test("sessionsCommand --limit caps the listed rows", () => {
  const { home, restore } = isolatedHome("rocky-sessions-limit-");
  try {
    const H = 3600_000;
    writeMemoryFixture(home, [
      ...oneSessionFixture(),
      {
        kind: "failure", id: "f2", ts: BASE_TS + 5 * H, cwd: "C:/work/other", cmd: "cargo build", exitCode: 1,
        fingerprint: "def456", signature: ["error[E0433]"], excerpt: "error[E0433]: unresolved import",
      },
    ]);
    const { code, stderr } = captureStderr(() => sessionsCommand(["--limit", "1"]));
    assert.equal(code, 0);
    assert.match(stderr, /\[1\]/);
    assert.doesNotMatch(stderr, /\[2\]/);
  } finally {
    restore();
  }
});

test("sessionsCommand with no sessions yet still speaks and does not throw", () => {
  const { restore } = isolatedHome("rocky-sessions-none-");
  try {
    const { code, stderr } = captureStderr(() => sessionsCommand([]));
    assert.equal(code, 0);
    assert.ok(stderr.length > 0);
  } finally {
    restore();
  }
});

test("sessionsCommand rejects a non-numeric --limit value", () => {
  const { restore } = isolatedHome("rocky-sessions-badlimit-");
  try {
    const { code } = captureStderr(() => sessionsCommand(["--limit", "abc"]));
    assert.equal(code, 2);
  } finally {
    restore();
  }
});

test("sessionsCommand rejects an unexpected argument", () => {
  const { restore } = isolatedHome("rocky-sessions-badarg-");
  try {
    const { code } = captureStderr(() => sessionsCommand(["--bogus"]));
    assert.equal(code, 2);
  } finally {
    restore();
  }
});
