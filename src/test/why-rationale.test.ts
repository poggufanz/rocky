import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryRecord, RationaleRecord, RationaleSource, TripleRecord } from "../core/memory-read.js";
import { CliUsageError } from "../commands/cli-args.js";
import { rationaleSourceLabel, why } from "../commands/dictionary.js";
import { validateRockyPhrase } from "../ui/phrases.js";

const WHY_ADD_USAGE = 'rocky why --add "<text>" [--files a.ts,b.ts]';
const WHY_ADD_REMEMBERED = "why remembered. you said it, rocky keeps it.";

function freshHome(label: string): void {
  process.env.ROCKY_HOME = realpathSync(mkdtempSync(join(tmpdir(), `rocky-why-${label}-`)));
}

async function storedRationales(): Promise<RationaleRecord[]> {
  const { loadMemory } = await import("../core/memory-read.js");
  return loadMemory().filter((record): record is RationaleRecord => record.kind === "rationale");
}

test("why --add writes human rationale linked to latest failure", async () => {
  process.env.ROCKY_HOME = realpathSync(mkdtempSync(join(tmpdir(), "rocky-why-")));
  const { recordWatchFailure } = await import("../core/memory.js");
  const failure = recordWatchFailure("npm test", 1, "Error: boom", process.cwd());
  const code = why(["--add", "flaky because tmpdir symlink"]);
  assert.equal(code, 0);
  const { loadMemory } = await import("../core/memory-read.js");
  const rec = loadMemory().find((r) => r.kind === "rationale");
  assert.ok(rec);
  assert.equal((rec as { source: string }).source, "human");
  assert.equal((rec as { links?: { failureId?: string } }).links?.failureId, failure.id);
});

test("why --add with empty memory still records unlinked", async () => {
  process.env.ROCKY_HOME = realpathSync(mkdtempSync(join(tmpdir(), "rocky-why2-")));
  assert.equal(why(["--add", "context note"]), 0);
  const { loadMemory } = await import("../core/memory-read.js");
  const rec = loadMemory().find((r) => r.kind === "rationale");
  assert.ok(rec);
  assert.equal((rec as RationaleRecord).links, undefined);
});

test("why --add refuses empty text and writes nothing", async () => {
  process.env.ROCKY_HOME = realpathSync(mkdtempSync(join(tmpdir(), "rocky-why3-")));
  assert.equal(why(["--add"]), 1);
  assert.equal(why(["--add", "   "]), 1);
  const spoken: string[] = [];
  assert.equal(why(["--add", "--files", "src/a.ts"], { say: (line) => spoken.push(line) }), 1);
  assert.deepEqual(spoken, ['why --add needs word to remember. rocky why --add "some reason", question']);
  const { loadMemory } = await import("../core/memory-read.js");
  assert.equal(loadMemory().some((r) => r.kind === "rationale"), false);
});

test("why --add --files stores a file-scoped reason and skips the recency link", async () => {
  freshHome("files");
  const { recordWatchFailure } = await import("../core/memory.js");
  recordWatchFailure("npm test", 1, "Error: boom", process.cwd());
  const spoken: string[] = [];

  const code = why(["--add", "because", "build", "--files", "src/a.ts,src/b.ts"], { say: (line) => spoken.push(line) });

  assert.equal(code, 0);
  const stored = await storedRationales();
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.source, "human");
  assert.equal(stored[0]?.excerpt, "because build");
  assert.deepEqual(stored[0]?.files, ["src/a.ts", "src/b.ts"]);
  assert.equal(stored[0]?.links, undefined);
  assert.deepEqual(spoken, [WHY_ADD_REMEMBERED]);
  assert.deepEqual(validateRockyPhrase(WHY_ADD_REMEMBERED), []);
});

test("why --add reads --files from any position and trims its comma list", async () => {
  freshHome("grammar");

  const code = why(["--add", "--files", " src/a.ts , ,src/b.ts,", "because", "build"], { say: () => undefined });

  assert.equal(code, 0);
  const stored = await storedRationales();
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.excerpt, "because build");
  assert.deepEqual(stored[0]?.files, ["src/a.ts", "src/b.ts"]);
});

test("why --add --files without a usable path is a usage error and writes nothing", async () => {
  freshHome("usage");
  const spoken: string[] = [];
  const cases: ReadonlyArray<{ argv: string[]; message: string }> = [
    { argv: ["--add", "x", "--files"], message: "--files needs path" },
    { argv: ["--add", "x", "--files", ""], message: "--files needs path" },
    { argv: ["--add", "x", "--files", "   "], message: "--files needs path" },
    { argv: ["--add", "x", "--files", " , ,"], message: "--files needs path" },
    { argv: ["--add", "x", "--files", "--diff"], message: "--files needs path" },
    { argv: ["--add", "x", "--files", "a.ts", "--files", "b.ts"], message: "unexpected option: --files" },
  ];

  for (const { argv, message } of cases) {
    assert.throws(
      () => why(argv, { say: (line) => spoken.push(line) }),
      (error: unknown) => error instanceof CliUsageError && error.message === message && error.usage === WHY_ADD_USAGE,
      argv.join(" "),
    );
  }

  assert.deepEqual(spoken, []);
  assert.deepEqual(await storedRationales(), []);
});

test("why --add without --files keeps the recency link to the newest failure", async () => {
  freshHome("text-only");
  const { recordWatchFailure } = await import("../core/memory.js");
  const failure = recordWatchFailure("npm test", 1, "Error: boom", process.cwd());
  const spoken: string[] = [];

  const code = why(["--add", "text only"], { say: (line) => spoken.push(line) });

  assert.equal(code, 0);
  const stored = await storedRationales();
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.links?.failureId, failure.id);
  assert.equal(stored[0]?.files, undefined);
  assert.deepEqual(spoken, [WHY_ADD_REMEMBERED]);
});

test("why --add --files with every path dropped keeps the reason and says no file kept", async () => {
  freshHome("dropped");
  const spoken: string[] = [];

  // Parentheses are legal in real paths (Next.js route groups), yet the shared
  // plausibility rule drops them. The line must not blame the path.
  const code = why(["--add", "route group", "--files", "app/(auth)/page.tsx"], { say: (line) => spoken.push(line) });

  assert.equal(code, 0);
  const stored = await storedRationales();
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.excerpt, "route group");
  assert.equal(stored[0]?.files, undefined);
  assert.equal(stored[0]?.links, undefined);
  assert.deepEqual(spoken, ["reason remembered. no file kept."]);
  assert.deepEqual(validateRockyPhrase(spoken[0] ?? ""), []);
});

test("why --add --files keeps the plausible paths when only some are dropped", async () => {
  freshHome("partial");
  const spoken: string[] = [];

  const code = why(["--add", "route group", "--files", "src/a.ts,app/(auth)/page.tsx"], { say: (line) => spoken.push(line) });

  assert.equal(code, 0);
  const stored = await storedRationales();
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0]?.files, ["src/a.ts"]);
  assert.deepEqual(spoken, [WHY_ADD_REMEMBERED]);
});

test("rationaleSourceLabel returns the four voice-approved labels", () => {
  assert.equal(rationaleSourceLabel("log-thinking"), "heard from thinking");
  assert.equal(rationaleSourceLabel("log-response"), "agent said in reply");
  assert.equal(rationaleSourceLabel("notify"), "agent said");
  assert.equal(rationaleSourceLabel("human"), "you said");
});

test("why labels source of every rationale record linked to a matched triple", () => {
  const now = Date.now();
  const path = "src/app.css";
  const triple: TripleRecord = {
    kind: "triple", id: "triple-1", ts: now - 1000, cwd: "/repo", platform: "linux",
    schemaV: 1, agent: "codex", origin: "agent-hook",
    intent: { text: "fix margin" },
    mechanism: {
      files: [{ path, plusMinus: [3, 1], props: ["margin-top"], provenance: "tool-observed" }],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  };
  const makeRationale = (id: string, source: RationaleSource, excerpt: string, tripleId = "triple-1"): RationaleRecord => ({
    kind: "rationale", id, ts: now, v: 1, cwd: "/repo",
    agent: source === "human" ? "human" : "claude-code",
    rationale_fidelity: "summary", source, excerpt,
    links: { tripleId },
  });
  const memory: MemoryRecord[] = [
    triple,
    makeRationale("r-think", "log-thinking", "excerpt-think"),
    makeRationale("r-reply", "log-response", "excerpt-reply"),
    makeRationale("r-notify", "notify", "excerpt-notify"),
    makeRationale("r-human", "human", "excerpt-human"),
    makeRationale("r-unlinked", "human", "excerpt-unlinked", "some-other-triple"),
  ];
  const sayLines: string[] = [];
  assert.equal(why([path], { load: () => memory, say: (line) => sayLines.push(line), now }), 0);
  assert.ok(sayLines.includes("heard from thinking: excerpt-think"));
  assert.ok(sayLines.includes("agent said in reply: excerpt-reply"));
  assert.ok(sayLines.includes("agent said: excerpt-notify"));
  assert.ok(sayLines.includes("you said: excerpt-human"));
  assert.ok(!sayLines.some((line) => line.includes("excerpt-unlinked")));
});

test("why with no linked rationale prints exactly what it printed before this feature", () => {
  const now = Date.now();
  const path = "src/app.css";
  const triple: TripleRecord = {
    kind: "triple", id: "triple-2", ts: now - 1000, cwd: "/repo", platform: "linux",
    schemaV: 1, agent: "codex", origin: "agent-hook",
    intent: { text: "fix margin" },
    mechanism: {
      files: [{ path, plusMinus: [3, 1], props: ["margin-top"], provenance: "tool-observed" }],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  };
  const sayLines: string[] = [];
  assert.equal(why([path], { load: () => [triple], say: (line) => sayLines.push(line), now }), 0);
  assert.deepEqual(sayLines, ["change happen. no reason I hear."]);
});
