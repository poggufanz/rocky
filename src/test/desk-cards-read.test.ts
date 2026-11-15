import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { canonicalPath } from "../core/memory-read.js";
import { cardsForFile, type StoredBlock, type StoredCard } from "../desk/cards-read.js";
import { cardsFilePath } from "../listening/cards-path.js";
import { probeSymlink, skipIfSymlinkUnavailable } from "./symlink-capability.js";

function makeTempDir(t: { after(fn: () => void): void }, prefix = "rocky-desk-cards-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function makeBlock(seq: number, path: string, overrides: Partial<StoredBlock> = {}): StoredBlock {
  return {
    seq,
    path,
    symbol: null,
    labels: [{ id: "body_changed", args: {} }],
    importance: "medium",
    via: "edit",
    tool_use_ids: [`tu-${seq}`],
    bash: null,
    before: null,
    after: null,
    recorded: true,
    line: 10,
    added: 2,
    removed: 1,
    quote: null,
    ...overrides,
  };
}

function makeCard(
  cardId: string,
  root: string,
  blocks: StoredBlock[],
  overrides: Partial<StoredCard> = {},
): StoredCard {
  return {
    v: 1,
    card_id: cardId,
    rev: 1,
    repo_id: "repo-id-1",
    root,
    main_root: null,
    branch: "main",
    session_id: "sess-1",
    agent_id: "agent-1",
    agent_type: "",
    parent_card_id: null,
    started_ms: 1000,
    ended_ms: 2000,
    status: "done",
    prompt: "Update target file",
    prompt_truncated: false,
    importance: "medium",
    blocks,
    more_count: 0,
    flow: [],
    flow_more: 0,
    outside_count: 0,
    coverage: { state: "complete", reasons: [] },
    ...overrides,
  };
}

function writeJsonl(filePath: string, entries: readonly unknown[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const text = entries.map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry)).join("\n") + "\n";
  writeFileSync(filePath, text, "utf8");
}

function makeRepo(baseDir: string, name = "repo"): { repoRoot: string; filePath: string } {
  const repoRoot = join(baseDir, name);
  mkdirSync(join(repoRoot, ".git"), { recursive: true });
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  const filePath = join(repoRoot, "src", "target.ts");
  writeFileSync(filePath, "export const x = 1;\n", "utf8");
  return { repoRoot, filePath };
}

test("missing cards directory and missing log file return empty complete coverage", (t) => {
  const temp = makeTempDir(t);
  const home = join(temp, "home");
  const { repoRoot, filePath } = makeRepo(temp);

  const missingDir = cardsForFile(filePath, { home });
  assert.equal(missingDir.cards.length, 0);
  assert.equal(missingDir.matched.size, 0);
  assert.deepEqual(missingDir.coverage, { complete: true, skipped: 0 });

  mkdirSync(join(home, "desk", "cards"), { recursive: true });
  const missingFile = cardsForFile(filePath, { home, cwd: repoRoot });
  assert.equal(missingFile.cards.length, 0);
  assert.equal(missingFile.matched.size, 0);
  assert.deepEqual(missingFile.coverage, { complete: true, skipped: 0 });

  const outsideFile = join(temp, "outside-missing.txt");
  const missingNone = cardsForFile(outsideFile, { home });
  assert.equal(missingNone.cards.length, 0);
  assert.equal(missingNone.matched.size, 0);
  assert.deepEqual(missingNone.coverage, { complete: true, skipped: 0 });
});

test("latest revision wins, stale revs are ignored, dropped file disappears, and matched preserves order", (t) => {
  const temp = makeTempDir(t);
  const home = join(temp, "home");
  const { repoRoot, filePath } = makeRepo(temp);
  const canonicalRoot = canonicalPath(repoRoot);
  const logPath = cardsFilePath(canonicalRoot, home);

  const b1 = makeBlock(1, "src/target.ts", {
    symbol: { kind: "function", name: "first", container: "ModuleA", exported: true },
    quote: { text: "fix off-by-one", shared: false },
  });
  const b2 = makeBlock(2, "src/other.ts");
  const b3 = makeBlock(3, "src/target.ts", {
    via: "bash",
    bash: { cmd: "sed -i ...", candidates: 2 },
    labels: [{ id: "lines_changed", args: {} }],
  });

  writeJsonl(logPath, [
    // Card dropped target file in rev 2 -> must not be returned.
    makeCard("card-dropped", canonicalRoot, [makeBlock(1, "src/target.ts")], { rev: 1, ended_ms: 5000 }),
    makeCard("card-dropped", canonicalRoot, [makeBlock(2, "src/other.ts")], { rev: 2, ended_ms: 5100 }),

    // Higher rev wins even if an older rev appears later in the log.
    makeCard("card-rev", canonicalRoot, [makeBlock(1, "src/other.ts")], { rev: 1, ended_ms: 3000 }),
    makeCard("card-rev", canonicalRoot, [b1, b2, b3], { rev: 3, ended_ms: 3500 }),
    makeCard("card-rev", canonicalRoot, [makeBlock(9, "src/other.ts")], { rev: 2, ended_ms: 3200 }),

    // Equal rev: later line wins.
    makeCard("card-tie", canonicalRoot, [makeBlock(1, "src/other.ts")], { rev: 2, ended_ms: 4000 }),
    makeCard("card-tie", canonicalRoot, [makeBlock(2, "src/target.ts")], { rev: 2, ended_ms: 4100 }),
  ]);

  const result = cardsForFile(filePath, { home });
  assert.deepEqual(result.coverage, { complete: true, skipped: 0 });
  assert.deepEqual(result.cards.map((c) => c.card_id), ["card-tie", "card-rev"]);

  const tieBlocks = result.matched.get("card-tie");
  assert.equal(tieBlocks?.length, 1);
  assert.equal(tieBlocks?.[0]?.seq, 2);

  const revBlocks = result.matched.get("card-rev");
  assert.equal(revBlocks?.length, 2);
  assert.deepEqual(revBlocks?.map((b) => b.seq), [1, 3]);
  assert.equal(revBlocks?.[0]?.quote?.text, "fix off-by-one");
  assert.equal(revBlocks?.[0]?.symbol?.container, "ModuleA");
  assert.equal(revBlocks?.[1]?.bash?.cmd, "sed -i ...");
});

test("subagent cards in the same log are returned with agent_type and parent_card_id intact", (t) => {
  const temp = makeTempDir(t);
  const home = join(temp, "home");
  const { repoRoot, filePath } = makeRepo(temp);
  const canonicalRoot = canonicalPath(repoRoot);
  const logPath = cardsFilePath(canonicalRoot, home);

  writeJsonl(logPath, [
    makeCard("card-parent", canonicalRoot, [makeBlock(1, "src/target.ts")], {
      ended_ms: 1500,
      agent_type: "",
      parent_card_id: null,
    }),
    makeCard("card-child", canonicalRoot, [makeBlock(1, "src/target.ts")], {
      ended_ms: 2500,
      agent_id: "sub-1",
      agent_type: "implementer",
      parent_card_id: "card-parent",
    }),
  ]);

  const result = cardsForFile(filePath, { home });
  assert.equal(result.cards.length, 2);
  assert.equal(result.cards[0]?.card_id, "card-child");
  assert.equal(result.cards[0]?.agent_type, "implementer");
  assert.equal(result.cards[0]?.parent_card_id, "card-parent");
  assert.equal(result.cards[1]?.card_id, "card-parent");
});

test("worktree root with a .git file resolves cards stored under worktree root", (t) => {
  const temp = makeTempDir(t);
  const home = join(temp, "home");
  const mainRepo = join(temp, "main-repo");
  mkdirSync(join(mainRepo, ".git", "worktrees", "wt-cards"), { recursive: true });

  const worktree = join(temp, "wt-cards");
  mkdirSync(join(worktree, "src"), { recursive: true });
  writeFileSync(join(worktree, ".git"), `gitdir: ${join(mainRepo, ".git", "worktrees", "wt-cards")}\n`, "utf8");
  writeFileSync(join(worktree, "src", "panel.ts"), "export {};\n", "utf8");

  const canonicalWt = canonicalPath(worktree);
  const logPath = cardsFilePath(canonicalWt, home);
  writeJsonl(logPath, [
    makeCard("card-wt", canonicalWt, [makeBlock(1, "src/panel.ts")], { ended_ms: 3000 }),
  ]);

  const result = cardsForFile(join("src", "panel.ts"), { home, cwd: worktree });
  assert.deepEqual(result.coverage, { complete: true, skipped: 0 });
  assert.deepEqual(result.cards.map((c) => c.card_id), ["card-wt"]);
});

test("_none.jsonl matches absolute path and ~/ path when file is outside any git repo", (t) => {
  const temp = makeTempDir(t);
  const home = join(temp, "rocky-home");
  const fakeUserHome = join(temp, "user-home");
  mkdirSync(join(fakeUserHome, "notes"), { recursive: true });

  const outsideDir = join(temp, "no-git-dir");
  mkdirSync(outsideDir, { recursive: true });
  const absFile = join(outsideDir, "scratch.md");
  writeFileSync(absFile, "# notes\n", "utf8");

  const homeFile = join(fakeUserHome, "notes", "todo.md");
  writeFileSync(homeFile, "- item\n", "utf8");

  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = fakeUserHome;
  process.env.USERPROFILE = fakeUserHome;
  try {
    assert.equal(canonicalPath(homedir()), canonicalPath(fakeUserHome));

    const noneLog = join(home, "desk", "cards", "_none.jsonl");
    writeJsonl(noneLog, [
      makeCard("card-abs", "", [makeBlock(1, canonicalPath(absFile))], { ended_ms: 1000 }),
      makeCard("card-tilde", "", [makeBlock(1, "~/notes/todo.md")], { ended_ms: 2000 }),
      makeCard("card-other", "", [makeBlock(1, "~/notes/unrelated.md")], { ended_ms: 3000 }),
    ]);

    const resAbs = cardsForFile(absFile, { home });
    assert.deepEqual(resAbs.coverage, { complete: true, skipped: 0 });
    assert.deepEqual(resAbs.cards.map((c) => c.card_id), ["card-abs"]);

    const resHome = cardsForFile(homeFile, { home });
    assert.deepEqual(resHome.coverage, { complete: true, skipped: 0 });
    assert.deepEqual(resHome.cards.map((c) => c.card_id), ["card-tilde"]);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
  }
});

test("platform option controls case folding and backslash normalization when matching block paths", (t) => {
  const temp = makeTempDir(t);
  const home = join(temp, "home");
  const { repoRoot, filePath } = makeRepo(temp);
  const canonicalRoot = canonicalPath(repoRoot);
  const logPath = cardsFilePath(canonicalRoot, home);

  writeJsonl(logPath, [
    makeCard("card-mixed", canonicalRoot, [makeBlock(1, "Src\\Target.TS")], { ended_ms: 4000 }),
  ]);

  const winResult = cardsForFile("src/target.ts", { home, cwd: repoRoot, platform: "win32" });
  assert.deepEqual(winResult.cards.map((c) => c.card_id), ["card-mixed"]);

  const linuxMiss = cardsForFile(filePath, { home, platform: "linux" });
  assert.equal(linuxMiss.cards.length, 0);
  assert.deepEqual(linuxMiss.coverage, { complete: true, skipped: 0 });
});

test("directory in place of log file returns empty cards with complete=false", (t) => {
  const temp = makeTempDir(t);
  const home = join(temp, "home");
  const { repoRoot, filePath } = makeRepo(temp);
  const logPath = cardsFilePath(canonicalPath(repoRoot), home);
  mkdirSync(logPath, { recursive: true });

  const result = cardsForFile(filePath, { home });
  assert.equal(result.cards.length, 0);
  assert.equal(result.matched.size, 0);
  assert.equal(result.coverage.complete, false);
});

test("symlinked log file is refused with empty cards and complete=false", (t) => {
  if (skipIfSymlinkUnavailable(t, "file")) return;

  const temp = makeTempDir(t);
  const home = join(temp, "home");
  const { repoRoot, filePath } = makeRepo(temp);
  const canonicalRoot = canonicalPath(repoRoot);
  const logPath = cardsFilePath(canonicalRoot, home);
  const targetLog = join(temp, "decoy.jsonl");

  writeJsonl(targetLog, [
    makeCard("card-secret", canonicalRoot, [makeBlock(1, "src/target.ts")]),
  ]);
  mkdirSync(dirname(logPath), { recursive: true });
  symlinkSync(targetLog, logPath, "file");

  const result = cardsForFile(filePath, { home });
  assert.equal(result.cards.length, 0);
  assert.equal(result.matched.size, 0);
  assert.equal(result.coverage.complete, false);
});

test("symlinked repo root falls back to realpath root spelling", (t) => {
  const dirCap = probeSymlink("dir");
  if (!dirCap.available && process.platform !== "win32") {
    t.skip(`symlink dir unavailable: ${dirCap.code}; owner: host filesystem capability`);
    return;
  }

  const temp = makeTempDir(t);
  const home = join(temp, "home");
  const { repoRoot } = makeRepo(temp, "real-repo");
  const realRoot = canonicalPath(realpathSync(repoRoot));
  const linkRoot = join(temp, "link-repo");
  symlinkSync(repoRoot, linkRoot, dirCap.available ? "dir" : "junction");

  // Store cards under the canonical realpath spelling, then query via the symlinked path.
  const logPath = cardsFilePath(realRoot, home);
  writeJsonl(logPath, [
    makeCard("card-realpath", realRoot, [makeBlock(1, "src/target.ts")], { ended_ms: 2500 }),
  ]);

  const result = cardsForFile(join(linkRoot, "src", "target.ts"), { home });
  assert.deepEqual(result.coverage, { complete: true, skipped: 0 });
  assert.deepEqual(result.cards.map((c) => c.card_id), ["card-realpath"]);
});

test("internal file symlink distinguishes its history from its target", (t) => {
  if (skipIfSymlinkUnavailable(t, "file")) return;

  const temp = makeTempDir(t);
  const home = join(temp, "home");
  const { repoRoot } = makeRepo(temp);
  const canonicalRoot = canonicalPath(repoRoot);
  const logPath = cardsFilePath(canonicalRoot, home);

  const realFile = join(repoRoot, "src", "real.ts");
  const linkFile = join(repoRoot, "src", "link.ts");
  writeFileSync(realFile, "export const real = 1;\n", "utf8");
  symlinkSync(realFile, linkFile, "file");

  writeJsonl(logPath, [
    makeCard("card-real-only", canonicalRoot, [makeBlock(1, "src/real.ts")], { ended_ms: 1000 }),
    makeCard("card-link-only", canonicalRoot, [makeBlock(1, "src/link.ts")], { ended_ms: 2000 }),
  ]);

  const linkResult = cardsForFile(linkFile, { home });
  assert.deepEqual(linkResult.coverage, { complete: true, skipped: 0 });
  assert.deepEqual(linkResult.cards.map((c) => c.card_id), ["card-link-only"]);

  const realResult = cardsForFile(realFile, { home });
  assert.deepEqual(realResult.coverage, { complete: true, skipped: 0 });
  assert.deepEqual(realResult.cards.map((c) => c.card_id), ["card-real-only"]);
});

test("internal directory symlink distinguishes its history from its target", (t) => {
  const dirCap = probeSymlink("dir");
  if (!dirCap.available && process.platform !== "win32") {
    t.skip(`symlink dir unavailable: ${dirCap.code}; owner: host filesystem capability`);
    return;
  }

  const temp = makeTempDir(t);
  const home = join(temp, "home");
  const { repoRoot } = makeRepo(temp);
  const canonicalRoot = canonicalPath(repoRoot);
  const logPath = cardsFilePath(canonicalRoot, home);

  const realDir = join(repoRoot, "src", "real-dir");
  const linkDir = join(repoRoot, "src", "link-dir");
  mkdirSync(realDir, { recursive: true });
  const realFile = join(realDir, "item.ts");
  writeFileSync(realFile, "export const item = 1;\n", "utf8");
  symlinkSync(realDir, linkDir, dirCap.available ? "dir" : "junction");
  const linkFile = join(linkDir, "item.ts");

  writeJsonl(logPath, [
    makeCard("card-real-dir-only", canonicalRoot, [makeBlock(1, "src/real-dir/item.ts")], { ended_ms: 1000 }),
    makeCard("card-link-dir-only", canonicalRoot, [makeBlock(1, "src/link-dir/item.ts")], { ended_ms: 2000 }),
  ]);

  const linkResult = cardsForFile(linkFile, { home });
  assert.deepEqual(linkResult.coverage, { complete: true, skipped: 0 });
  assert.deepEqual(linkResult.cards.map((c) => c.card_id), ["card-link-dir-only"]);

  const realResult = cardsForFile(realFile, { home });
  assert.deepEqual(realResult.coverage, { complete: true, skipped: 0 });
  assert.deepEqual(realResult.cards.map((c) => c.card_id), ["card-real-dir-only"]);
});

test("16 MiB file size cap reads tail only and marks complete=false with reason=file-size-cap", (t) => {
  const temp = makeTempDir(t);
  const home = join(temp, "home");
  const { repoRoot, filePath } = makeRepo(temp);
  const canonicalRoot = canonicalPath(repoRoot);
  const logPath = cardsFilePath(canonicalRoot, home);
  mkdirSync(dirname(logPath), { recursive: true });

  const oldLine = JSON.stringify(makeCard("card-old-before-cap", canonicalRoot, [makeBlock(1, "src/target.ts")], { ended_ms: 100 }));
  const padPrompt = "x".repeat(60_000);
  const fillerLine = JSON.stringify(
    makeCard("card-filler", canonicalRoot, [makeBlock(1, "src/other.ts")], {
      rev: 1,
      prompt: padPrompt,
      ended_ms: 200,
    }),
  );
  // Exceed 16 MiB so the oldest line falls before the 16 MiB tail window.
  const targetPaddingBytes = 16 * 1024 * 1024 + 128 * 1024;
  const repeatCount = Math.ceil(targetPaddingBytes / (fillerLine.length + 1));
  const chunks: string[] = [oldLine + "\n"];
  for (let i = 0; i < repeatCount; i++) {
    chunks.push(fillerLine + "\n");
  }
  const recentLine = JSON.stringify(
    makeCard("card-tail-new", canonicalRoot, [makeBlock(1, "src/target.ts")], { ended_ms: 9000 }),
  );
  chunks.push(recentLine + "\n");
  writeFileSync(logPath, chunks.join(""), "utf8");

  const result = cardsForFile(filePath, { home });
  assert.deepEqual(result.cards.map((c) => c.card_id), ["card-tail-new"]);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.reason, "file-size-cap");
  assert.equal(result.coverage.skipped, 0);
});

test("1 MiB line cap skips oversized line with reason=line-cap and preserves valid cards", (t) => {
  const temp = makeTempDir(t);
  const home = join(temp, "home");
  const { repoRoot, filePath } = makeRepo(temp);
  const canonicalRoot = canonicalPath(repoRoot);
  const logPath = cardsFilePath(canonicalRoot, home);

  const hugeCard = JSON.stringify(
    makeCard("card-huge", canonicalRoot, [makeBlock(1, "src/target.ts")], {
      prompt: "z".repeat(1024 * 1024 + 512),
    }),
  );

  writeJsonl(logPath, [
    makeCard("card-before", canonicalRoot, [makeBlock(1, "src/target.ts")], { ended_ms: 1000 }),
    hugeCard,
    makeCard("card-after", canonicalRoot, [makeBlock(1, "src/target.ts")], { ended_ms: 2000 }),
  ]);

  const result = cardsForFile(filePath, { home });
  assert.deepEqual(result.cards.map((c) => c.card_id), ["card-after", "card-before"]);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.reason, "line-cap");
  assert.equal(result.coverage.skipped, 1);
});

test("malformed JSON and invalid schema fields increment skipped while extra fields pass", (t) => {
  const temp = makeTempDir(t);
  const home = join(temp, "home");
  const { repoRoot, filePath } = makeRepo(temp);
  const canonicalRoot = canonicalPath(repoRoot);
  const logPath = cardsFilePath(canonicalRoot, home);

  const withExtraField = {
    ...makeCard("card-valid-extra", canonicalRoot, [makeBlock(1, "src/target.ts")], { ended_ms: 3000 }),
    future_top_level: { version: 99 },
  };
  const badVersion = { ...makeCard("card-bad-v", canonicalRoot, [makeBlock(1, "src/target.ts")]), v: 2 };
  const badQuote = makeCard("card-bad-quote", canonicalRoot, [
    { ...makeBlock(1, "src/target.ts"), quote: "not-an-object" as unknown as StoredBlock["quote"] },
  ]);
  const badVia = makeCard("card-bad-via", canonicalRoot, [
    { ...makeBlock(1, "src/target.ts"), via: 123 as unknown as string },
  ]);
  const stringVia = makeCard("card-string-via", canonicalRoot, [
    makeBlock(1, "src/target.ts", { via: "python" }),
  ], { ended_ms: 4000 });
  const missingEndedMs: Record<string, unknown> = {
    ...makeCard("card-no-ended", canonicalRoot, [makeBlock(1, "src/target.ts")]),
  };
  delete missingEndedMs.ended_ms;

  writeJsonl(logPath, [
    "{broken json",
    badVersion,
    badQuote,
    badVia,
    missingEndedMs,
    "",
    withExtraField,
    stringVia,
  ]);

  const result = cardsForFile(filePath, { home });
  assert.deepEqual(result.cards.map((c) => c.card_id), ["card-string-via", "card-valid-extra"]);
  assert.equal(result.matched.get("card-string-via")?.[0]?.via, "python");
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.reason, undefined);
  assert.equal(result.coverage.skipped, 5);
});

test("sort order uses ended_ms ?? started_ms desc then card_id asc and respects limit", (t) => {
  const temp = makeTempDir(t);
  const home = join(temp, "home");
  const { repoRoot, filePath } = makeRepo(temp);
  const canonicalRoot = canonicalPath(repoRoot);
  const logPath = cardsFilePath(canonicalRoot, home);

  writeJsonl(logPath, [
    makeCard("card-1", canonicalRoot, [makeBlock(1, "src/target.ts")], { started_ms: 100, ended_ms: 100 }),
    makeCard("card-2", canonicalRoot, [makeBlock(1, "src/target.ts")], { started_ms: 200, ended_ms: 200 }),
    makeCard("card-tie-b", canonicalRoot, [makeBlock(1, "src/target.ts")], { started_ms: 300, ended_ms: null }),
    makeCard("card-tie-a", canonicalRoot, [makeBlock(1, "src/target.ts")], { started_ms: 300, ended_ms: 300 }),
    makeCard("card-4", canonicalRoot, [makeBlock(1, "src/target.ts")], { started_ms: 400, ended_ms: 400 }),
    makeCard("card-5", canonicalRoot, [makeBlock(1, "src/target.ts")], { started_ms: 500, ended_ms: 500 }),
    makeCard("card-6", canonicalRoot, [makeBlock(1, "src/target.ts")], { started_ms: 600, ended_ms: null }),
  ]);

  const defaultLimit = cardsForFile(filePath, { home });
  assert.deepEqual(
    defaultLimit.cards.map((c) => c.card_id),
    ["card-6", "card-5", "card-4", "card-tie-a", "card-tie-b"],
  );
  assert.equal(defaultLimit.matched.size, 5);
  assert.equal(defaultLimit.matched.has("card-1"), false);
  assert.equal(defaultLimit.matched.has("card-2"), false);

  const customLimit = cardsForFile(filePath, { home, limit: 2 });
  assert.deepEqual(customLimit.cards.map((c) => c.card_id), ["card-6", "card-5"]);
  assert.equal(customLimit.matched.size, 2);

  const zeroLimit = cardsForFile(filePath, { home, limit: 0 });
  assert.equal(zeroLimit.cards.length, 0);
  assert.equal(zeroLimit.matched.size, 0);
});

test("16 MiB tail read preserves first card when cut lands on a line boundary and skips mid-line cuts", (t) => {
  const MAX_TAIL = 16 * 1024 * 1024;
  const temp = makeTempDir(t);
  const home = join(temp, "home");
  const { repoRoot, filePath } = makeRepo(temp, "repo-boundary");
  const canonicalRoot = canonicalPath(repoRoot);
  const logPath = cardsFilePath(canonicalRoot, home);

  const beforeCut = `${JSON.stringify(makeCard("card-before-cut", canonicalRoot, [makeBlock(1, "src/target.ts")], { ended_ms: 1000 }))}\n`;
  const boundaryCard = `${JSON.stringify(makeCard("card-exact-boundary", canonicalRoot, [makeBlock(1, "src/target.ts")], { ended_ms: 5000 }))}\n`;
  const boundaryLen = Buffer.byteLength(boundaryCard, "utf8");

  // Pad the remaining (MAX_TAIL - boundaryLen) bytes with valid non-matching cards of exact total length.
  const templateFiller = JSON.stringify(makeCard("card-filler", canonicalRoot, [makeBlock(1, "src/other.ts")], { prompt: "" }));
  const lineOverhead = Buffer.byteLength(templateFiller, "utf8") + 1;
  const lines: string[] = [];
  let remaining = MAX_TAIL - boundaryLen;
  let seq = 0;
  while (remaining > 0) {
    const id = `f-${seq++}`;
    const base = JSON.stringify(makeCard(id, canonicalRoot, [makeBlock(1, "src/other.ts")], { prompt: "" }));
    const baseLen = Buffer.byteLength(base, "utf8") + 1;
    const chunkTarget = remaining <= 800_000 ? remaining : 800_000;
    const padLen = chunkTarget - baseLen;
    if (padLen < 0) throw new Error(`unexpected filler size remaining=${remaining} baseLen=${baseLen}`);
    // Avoid leaving < lineOverhead bytes for the final line.
    const nextRem = remaining - chunkTarget;
    const adjustedChunk = nextRem > 0 && nextRem < lineOverhead + 10 ? chunkTarget - (lineOverhead + 20) : chunkTarget;
    const promptPad = "a".repeat(adjustedChunk - baseLen);
    const line = `${JSON.stringify(makeCard(id, canonicalRoot, [makeBlock(1, "src/other.ts")], { prompt: promptPad }))}\n`;
    lines.push(line);
    remaining -= Buffer.byteLength(line, "utf8");
  }

  mkdirSync(dirname(logPath), { recursive: true });
  const exactContent = `${beforeCut}${boundaryCard}${lines.join("")}`;
  assert.equal(Buffer.byteLength(exactContent, "utf8"), Buffer.byteLength(beforeCut, "utf8") + MAX_TAIL);
  writeFileSync(logPath, exactContent, "utf8");

  const exactRes = cardsForFile(filePath, { home });
  assert.equal(exactRes.coverage.complete, false);
  assert.equal(exactRes.coverage.reason, "file-size-cap");
  assert.equal(exactRes.coverage.skipped, 0);
  assert.deepEqual(exactRes.cards.map((c) => c.card_id), ["card-exact-boundary"]);

  // Shift cut 10 bytes into a matching card so pos - 1 is not 0x0a: that partial line must be skipped.
  const midCut = `${JSON.stringify(makeCard("card-mid-cut", canonicalRoot, [makeBlock(1, "src/target.ts")], { ended_ms: 4000 }))}\n`;
  const midAfter = `${JSON.stringify(makeCard("card-after-mid", canonicalRoot, [makeBlock(1, "src/target.ts")], { ended_ms: 6000 }))}\n`;
  const midTailLen = Buffer.byteLength(midCut, "utf8") - 10 + Buffer.byteLength(midAfter, "utf8");
  const midFillers: string[] = [];
  let midRem = MAX_TAIL - midTailLen;
  let midSeq = 0;
  while (midRem > 0) {
    const id = `mf-${midSeq++}`;
    const base = JSON.stringify(makeCard(id, canonicalRoot, [makeBlock(1, "src/other.ts")], { prompt: "" }));
    const baseLen = Buffer.byteLength(base, "utf8") + 1;
    const chunk = midRem <= 800_000 ? midRem : 800_000;
    const next = midRem - chunk;
    const adj = next > 0 && next < lineOverhead + 10 ? chunk - (lineOverhead + 20) : chunk;
    const line = `${JSON.stringify(makeCard(id, canonicalRoot, [makeBlock(1, "src/other.ts")], { prompt: "b".repeat(adj - baseLen) }))}\n`;
    midFillers.push(line);
    midRem -= Buffer.byteLength(line, "utf8");
  }
  writeFileSync(logPath, `${midCut}${midAfter}${midFillers.join("")}`, "utf8");

  const midRes = cardsForFile(filePath, { home });
  assert.equal(midRes.coverage.complete, false);
  assert.equal(midRes.coverage.reason, "file-size-cap");
  assert.deepEqual(midRes.cards.map((c) => c.card_id), ["card-after-mid"]);
});

test("mid-read race keeps cards parsed so far and reports read-race without retrying", (t) => {
  const temp = makeTempDir(t, "rocky-cards-race-");
  const home = join(temp, "home");
  const { repoRoot, filePath } = makeRepo(temp);
  const canonicalRoot = canonicalPath(repoRoot);
  const logPath = cardsFilePath(canonicalRoot, home);

  const first = makeCard("card-parsed-first", canonicalRoot, [makeBlock(1, "src/target.ts")], { ended_ms: 2000 });
  const filler = makeCard("card-chunk-two", canonicalRoot, [makeBlock(1, "src/other.ts")], { prompt: "z".repeat(70_000) });
  writeJsonl(logPath, [first, filler]);

  const marker = join(temp, "race-fired");
  const preload = join(temp, "cards-race.cjs");
  writeFileSync(preload, [
    "const fs = require('node:fs');",
    "const { syncBuiltinESMExports } = require('node:module');",
    "const originalOpen = fs.openSync.bind(fs);",
    "const originalRead = fs.readSync.bind(fs);",
    "const fds = new Set();",
    "let reads = 0;",
    "fs.openSync = (value, ...args) => { const fd = originalOpen(value, ...args); if (String(value) === process.env.ROCKY_TEST_CARDS_LOG) fds.add(fd); return fd; };",
    "fs.readSync = (fd, ...args) => { if (fds.has(fd)) { reads += 1; if (reads >= 2) { fs.writeFileSync(process.env.ROCKY_TEST_CARDS_MARKER, '1'); return 0; } } return originalRead(fd, ...args); };",
    "syncBuiltinESMExports();",
  ].join("\n"), "utf8");

  const modulePath = join(process.cwd(), "dist", "desk", "cards-read.js");
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", [
    `const { cardsForFile } = await import(${JSON.stringify(pathToFileURL(modulePath).href)});`,
    `const res = cardsForFile(${JSON.stringify(filePath)}, { home: ${JSON.stringify(home)} });`,
    "process.stdout.write(JSON.stringify({ ids: res.cards.map((c) => c.card_id), coverage: res.coverage }));",
  ].join("\n")], {
    env: {
      ...process.env,
      NODE_OPTIONS: `--require=${preload}`,
      ROCKY_TEST_CARDS_LOG: logPath,
      ROCKY_TEST_CARDS_MARKER: marker,
    },
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });

  assert.equal(child.status, 0, child.stderr);
  assert.equal(existsSync(marker), true);
  const parsed = JSON.parse(child.stdout) as { ids: string[]; coverage: { complete: boolean; reason?: string; skipped: number } };
  assert.deepEqual(parsed.ids, ["card-parsed-first"]);
  assert.deepEqual(parsed.coverage, { complete: false, reason: "read-race", skipped: 0 });
});

test("cross-log scan finds abs/~ blocks in _none, other repo, and own repo while rejecting foreign relative paths", (t) => {
  const temp = makeTempDir(t, "rocky-cross-log-");
  const home = join(temp, "home");
  const fakeUserHome = join(temp, "user-home");
  mkdirSync(join(fakeUserHome, "work"), { recursive: true });
  const { repoRoot, filePath } = makeRepo(join(fakeUserHome, "work"), "repo-a");
  const canonicalRoot = canonicalPath(repoRoot);
  const ownLog = cardsFilePath(canonicalRoot, home);
  const otherRepoRoot = join(fakeUserHome, "work", "repo-b");
  mkdirSync(join(otherRepoRoot, ".git"), { recursive: true });
  const otherLog = cardsFilePath(canonicalPath(otherRepoRoot), home);
  const noneLog = join(home, "desk", "cards", "_none.jsonl");

  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = fakeUserHome;
  process.env.USERPROFILE = fakeUserHome;
  try {
    writeJsonl(ownLog, [
      makeCard("card-own-rel", canonicalRoot, [makeBlock(1, "src/target.ts")], { ended_ms: 1000 }),
      makeCard("card-own-abs", canonicalRoot, [makeBlock(1, canonicalPath(filePath))], { ended_ms: 2000 }),
      makeCard("card-own-tilde", canonicalRoot, [makeBlock(1, "~/work/repo-a/src/target.ts")], { ended_ms: 3000 }),
    ]);
    writeJsonl(noneLog, [
      makeCard("card-none-abs", "", [makeBlock(1, canonicalPath(filePath))], { ended_ms: 4000 }),
      makeCard("card-none-rel-ignored", "", [makeBlock(1, "src/target.ts")], { ended_ms: 4500 }),
    ]);
    writeJsonl(otherLog, [
      makeCard("card-other-abs", canonicalPath(otherRepoRoot), [makeBlock(1, canonicalPath(filePath))], { ended_ms: 5000 }),
      makeCard("card-other-rel-ignored", canonicalPath(otherRepoRoot), [makeBlock(1, "src/target.ts")], { ended_ms: 6000 }),
    ]);

    const res = cardsForFile(filePath, { home });
    assert.deepEqual(res.coverage, { complete: true, skipped: 0 });
    assert.deepEqual(
      res.cards.map((c) => c.card_id),
      ["card-other-abs", "card-none-abs", "card-own-tilde", "card-own-abs", "card-own-rel"],
    );
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
  }
});

test("cross-log scan merges by card_id (latest rev wins, tie later log) and combines coverage", (t) => {
  const temp = makeTempDir(t, "rocky-cross-merge-");
  const home = join(temp, "home");
  const { repoRoot, filePath } = makeRepo(temp, "repo-main");
  const canonicalRoot = canonicalPath(repoRoot);
  const absTarget = canonicalPath(filePath);
  const ownLog = cardsFilePath(canonicalRoot, home);
  const logA = join(home, "desk", "cards", "aaaa.jsonl");
  const logZ = join(home, "desk", "cards", "zzzz.jsonl");

  const hugePrompt = "q".repeat(1024 * 1024 + 16);
  const lineCapCard = makeCard("card-over-line", canonicalRoot, [makeBlock(1, "src/other.ts")], { prompt: hugePrompt });

  writeJsonl(ownLog, [
    "{corrupt-own",
    makeCard("shared-drop", canonicalRoot, [makeBlock(1, "src/target.ts")], { rev: 1, ended_ms: 1000 }),
    makeCard("shared-tie", canonicalRoot, [makeBlock(1, "src/target.ts")], { rev: 2, prompt: "from-own", ended_ms: 3000 }),
  ]);
  writeJsonl(logA, [
    "{corrupt-a",
    lineCapCard,
    makeCard("shared-drop", "", [makeBlock(1, absTarget)], { rev: 2, ended_ms: 2000, blocks: [makeBlock(1, "/unrelated/file.ts")] }),
    makeCard("shared-tie", "", [makeBlock(1, absTarget)], { rev: 2, prompt: "from-log-a", ended_ms: 3000 }),
    makeCard("rev-wins", "", [makeBlock(1, absTarget)], { rev: 5, prompt: "winner-rev-5", ended_ms: 4000 }),
  ]);
  writeJsonl(logZ, [
    makeCard("shared-tie", "", [makeBlock(1, absTarget)], { rev: 2, prompt: "from-log-z", ended_ms: 3000 }),
    makeCard("rev-wins", "", [makeBlock(1, absTarget)], { rev: 4, prompt: "stale-rev-4", ended_ms: 4000 }),
  ]);

  const res = cardsForFile(filePath, { home });
  assert.deepEqual(res.cards.map((c) => c.card_id), ["rev-wins", "shared-tie"]);
  assert.equal(res.cards[0]?.prompt, "winner-rev-5");
  assert.equal(res.cards[1]?.prompt, "from-log-z");
  assert.equal(res.coverage.complete, false);
  assert.equal(res.coverage.reason, "line-cap");
  assert.equal(res.coverage.skipped, 3);
});

test("cross-log extra scan stops at 64 extra files or 64 MiB total read with file-size-cap", (t) => {
  const temp = makeTempDir(t, "rocky-cross-bounds-");
  const homeCount = join(temp, "home-count");
  const { repoRoot, filePath } = makeRepo(temp, "repo-bounds");
  const canonicalRoot = canonicalPath(repoRoot);
  const absTarget = canonicalPath(filePath);

  for (let i = 1; i <= 64; i += 1) {
    const name = `extra-${String(i).padStart(3, "0")}.jsonl`;
    writeJsonl(join(homeCount, "desk", "cards", name), [
      makeCard(`c-${i}`, "", [makeBlock(1, "/unrelated/file.ts")], { ended_ms: i }),
    ]);
  }
  const exact64 = cardsForFile(filePath, { home: homeCount });
  assert.deepEqual(exact64.coverage, { complete: true, skipped: 0 });

  writeJsonl(join(homeCount, "desk", "cards", "extra-065.jsonl"), [
    makeCard("card-65", "", [makeBlock(1, absTarget)], { ended_ms: 9999 }),
  ]);
  const over64 = cardsForFile(filePath, { home: homeCount });
  assert.equal(over64.coverage.complete, false);
  assert.equal(over64.coverage.reason, "file-size-cap");
  assert.equal(over64.cards.some((c) => c.card_id === "card-65"), false);

  const homeBytes = join(temp, "home-bytes");
  const fillerUnit = `${JSON.stringify(makeCard("filler", "", [makeBlock(1, "/unrelated/file.ts")], { prompt: "x".repeat(700_000) }))}\n`;
  const bigChunk = fillerUnit.repeat(20); // ~14 MiB per log
  writeJsonl(cardsFilePath(canonicalRoot, homeBytes), [bigChunk.trimEnd()]);
  for (let i = 1; i <= 4; i += 1) {
    const name = `bytes-${String(i).padStart(2, "0")}.jsonl`;
    const prefix = i === 4 ? `${JSON.stringify(makeCard("card-beyond-64mib", "", [makeBlock(1, absTarget)], { ended_ms: 8888 }))}\n` : "";
    mkdirSync(join(homeBytes, "desk", "cards"), { recursive: true });
    writeFileSync(join(homeBytes, "desk", "cards", name), `${prefix}${bigChunk}`, "utf8");
  }
  const overBytes = cardsForFile(filePath, { home: homeBytes });
  assert.equal(overBytes.coverage.complete, false);
  assert.equal(overBytes.coverage.reason, "file-size-cap");
  assert.equal(overBytes.cards.some((c) => c.card_id === "card-beyond-64mib"), false);
});
