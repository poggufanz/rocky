import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryCoverage, MemoryRecord, RationaleRecord, RationaleSource, TripleRecord } from "../core/memory-read.js";
import { CliUsageError } from "../commands/cli-args.js";
import { rationaleSourceLabel, why } from "../commands/dictionary.js";
import { validateRockyPhrase } from "../ui/phrases.js";
import { setVerbose } from "./verbose-switch.js";

const WHY_ADD_USAGE = 'rocky why --add "<text>" [--files a.ts,b.ts]';
const WHY_ADD_REMEMBERED = "why remembered. you said it, rocky keeps it.";
const NO_RECORD_NAMES_FILE = "no record names this file. I not know if agent touch it.";
const COVERAGE_INCOMPLETE_LINE = "I not know if agent touch. coverage incomplete.";

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

type Sink = (line: string) => void;

/** Both sinks into one list, so a test can pin which line comes before which. */
function orderedSinks(): { lines: string[]; deps: { say: Sink; out: Sink } } {
  const lines: string[] = [];
  return {
    lines,
    deps: {
      say: (line) => { lines.push(`say: ${line}`); },
      out: (line) => { lines.push(`out: ${line}`); },
    },
  };
}

/** A stated reason as `why --add --files` or the notify lane stores it, heard from this directory. */
function statedReason(input: { id: string; ts: number; source?: RationaleSource; files?: string[]; excerpt?: string }): RationaleRecord {
  const source = input.source ?? "human";
  return {
    kind: "rationale", id: input.id, ts: input.ts, v: 1, cwd: process.cwd(),
    agent: source === "human" ? "human" : "claude-code", rationale_fidelity: "summary", source,
    excerpt: input.excerpt ?? `reason ${input.id}`,
    ...(input.files === undefined ? {} : { files: input.files }),
  };
}

/** One record whose file list was cut short: any path might be hiding behind it. */
function truncatedTriple(ts: number): TripleRecord {
  return {
    kind: "triple", id: "may-hide", ts, cwd: "/repo", platform: "linux", schemaV: 1, agent: "codex", origin: "agent-hook",
    mechanism: {
      files: [{ path: "src/other.ts", plusMinus: [1, 0], props: [], provenance: "tool-observed" }],
      truncatedFiles: 4, baseline: "captured", coverageStatus: "truncated",
    },
  };
}

test("why <file> hears the human reason that why --add --files stored for that file", () => {
  freshHome("hear-human");
  assert.equal(why(["--add", "retries stay low", "--files", "src/net.ts"], { say: () => undefined }), 0);

  // No injected `now`: recordRationale stamps Date.now(), so an older `now` would hide the record as future-dated.
  const heard = orderedSinks();
  assert.equal(why(["src/net.ts"], heard.deps), 0);

  // Memory holds nothing but this reason, so no absence sentence may stand next to it.
  assert.deepEqual(heard.lines, [`say: ${rationaleSourceLabel("human")}: retries stay low`, "out:   (just now, human)"]);
});

test("why <file> hears a notify-lane reason that names the file", async () => {
  freshHome("hear-notify");
  const { recordRationale } = await import("../core/memory.js");
  recordRationale({
    cwd: process.cwd(), agent: "claude-code", rationale_fidelity: "summary", source: "notify",
    text: "moved retry into client", files: ["src/net.ts"],
  });

  const heard = orderedSinks();
  assert.equal(why(["src/net.ts"], heard.deps), 0);

  assert.deepEqual(heard.lines, [`say: ${rationaleSourceLabel("notify")}: moved retry into client`, "out:   (just now, claude-code)"]);
});

test("why <file> ignores reasons for other files, suffix paths, agent-log reasons, and reasons with no files", () => {
  const now = Date.now();
  const records: MemoryRecord[] = [
    statedReason({ id: "other-file", ts: now - 1000, files: ["src/other.ts"] }),
    statedReason({ id: "suffix", ts: now - 1000, files: ["web/src/net.ts"] }),
    statedReason({ id: "thinking", ts: now - 1000, source: "log-thinking", files: ["src/net.ts"] }),
    statedReason({ id: "unscoped", ts: now - 1000 }),
  ];
  const heard = orderedSinks();

  assert.equal(why(["src/net.ts"], { load: () => records, now, ...heard.deps }), 0);

  assert.deepEqual(heard.lines, [`say: "src/net.ts"... ${NO_RECORD_NAMES_FILE}`]);
});

test("why <file> prints the coverage disclosure before the stated reason and adds no absence sentence", (t) => {
  setVerbose(t, undefined);
  const now = Date.now();
  const scan: MemoryCoverage = { version: 1, scanned: 3, skipped: 0, truncated: 1, bytesScanned: 10, bytesTotal: 20, complete: false, reason: "file-size-cap" };
  const reason = statedReason({ id: "r1", ts: now - 120_000, files: ["src/net.ts"], excerpt: "retries stay low" });
  const heard = orderedSinks();

  assert.equal(why(["src/net.ts"], { load: () => [reason], coverage: () => scan, now, ...heard.deps }), 0);

  assert.deepEqual(heard.lines, [
    `say: "src/net.ts"... ${COVERAGE_INCOMPLETE_LINE}`,
    "out: memory coverage incomplete: memory file too big. first 1 records heard, later lines not heard.",
    "say: you said: retries stay low",
    "out:   (2 minutes ago, human)",
  ]);
});

test("why <file> prints possible path omitted before the stated reason", (t) => {
  setVerbose(t, undefined);
  const now = Date.now();
  const reason = statedReason({ id: "r1", ts: now - 120_000, files: ["src/net.ts"], excerpt: "retries stay low" });
  const heard = orderedSinks();

  assert.equal(why(["src/net.ts"], { load: () => [truncatedTriple(now - 60_000), reason], now, ...heard.deps }), 0);

  assert.deepEqual(heard.lines, [
    `say: "src/net.ts"... ${COVERAGE_INCOMPLETE_LINE}`,
    "out: possible path omitted.",
    "say: you said: retries stay low",
    "out:   (2 minutes ago, human)",
  ]);
});

test("why <file> keeps the coverage status on the possible path line under ROCKY_VERBOSE", (t) => {
  setVerbose(t, "1");
  const now = Date.now();
  const reason = statedReason({ id: "r1", ts: now - 120_000, files: ["src/net.ts"], excerpt: "retries stay low" });
  const heard = orderedSinks();

  assert.equal(why(["src/net.ts"], { load: () => [truncatedTriple(now - 60_000), reason], now, ...heard.deps }), 0);

  assert.deepEqual(heard.lines, [
    `say: "src/net.ts"... ${COVERAGE_INCOMPLETE_LINE}`,
    "out: coverage status: unknown; possible path omitted.",
    "say: you said: retries stay low",
    "out:   (2 minutes ago, human)",
  ]);
});

test("why <file> hears stated reasons after every triple it prints", () => {
  const now = Date.now();
  const hit: TripleRecord = {
    kind: "triple", id: "triple-hit", ts: now - 60_000, cwd: "/repo", platform: "linux", schemaV: 1, agent: "codex", origin: "agent-hook",
    intent: { text: "fix margin" },
    mechanism: {
      files: [{ path: "src/net.ts", plusMinus: [3, 1], props: ["margin-top"], provenance: "tool-observed" }],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  };
  const reason = statedReason({ id: "r1", ts: now - 120_000, files: ["src/net.ts"], excerpt: "retries stay low" });
  const heard = orderedSinks();

  assert.equal(why(["src/net.ts"], { load: () => [hit, reason], now, ...heard.deps }), 0);

  assert.equal(heard.lines[0], "say: change happen. no reason I hear.");
  assert.deepEqual(heard.lines.slice(-2), ["say: you said: retries stay low", "out:   (2 minutes ago, human)"]);
  assert.ok(heard.lines.length > 3, heard.lines.join("\n"));
});

test("why <file> says nothing of a stated reason when the path is ambiguous", () => {
  const make = (id: string, path: string): TripleRecord => ({
    kind: "triple", id, ts: 100, cwd: "/repo", platform: "linux", schemaV: 1, agent: "codex", origin: "agent-hook",
    rationale: { text: id, tags: [], source: "notify" },
    mechanism: {
      files: [{ path, plusMinus: [1, 0], props: [id], provenance: "tool-observed" }],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  });
  const named = statedReason({ id: "named-index", ts: 100, files: ["index.ts"] });
  const heard = orderedSinks();

  assert.equal(why(["index.ts"], { load: () => [make("one", "one/index.ts"), make("two", "two/index.ts"), named], now: 100, ...heard.deps }), 0);

  assert.ok(heard.lines.some((line) => line.includes("multiple possible paths")), heard.lines.join("\n"));
  assert.equal(heard.lines.some((line) => line.includes("named-index")), false, heard.lines.join("\n"));
});

test("why <file> hears at most five stated reasons, newest first", () => {
  const now = Date.now();
  const records = Array.from({ length: 7 }, (_, index) =>
    statedReason({ id: `r${index}`, ts: now - (index + 1) * 60_000, files: ["src/net.ts"] }));
  const said: string[] = [];

  assert.equal(why(["src/net.ts"], { load: () => records, now, say: (line) => said.push(line), out: () => undefined }), 0);

  assert.deepEqual(said, ["r0", "r1", "r2", "r3", "r4"].map((id) => `${rationaleSourceLabel("human")}: reason ${id}`));
});

test("why <file> keeps a hostile stated reason bounded, terminal-safe, and question-free", () => {
  const now = Date.now();
  const hostile = statedReason({
    id: "hostile", ts: now - 1000, files: ["src/net.ts"],
    excerpt: `why?\u001b[31m\nsecond line\u0007${"r".repeat(8_000)}`,
  });
  const heard = { said: [] as string[], detail: [] as string[] };

  assert.equal(why(["src/net.ts"], {
    load: () => [hostile], now, say: (line) => heard.said.push(line), out: (line) => heard.detail.push(line),
  }), 0);

  assert.equal(heard.said.length, 1);
  assert.ok(heard.said[0]?.startsWith(`${rationaleSourceLabel("human")}: why`), heard.said[0]);
  for (const line of [...heard.said, ...heard.detail]) {
    assert.ok(!line.includes("?"), JSON.stringify(line));
    assert.ok(!line.includes("\u001b"), JSON.stringify(line));
    assert.ok(!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(line), JSON.stringify(line));
    assert.ok(Buffer.byteLength(line, "utf8") <= 512, JSON.stringify(line));
  }
});
