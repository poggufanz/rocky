import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { canonicalPath } from "../core/memory-read.js";
import {
  cardsForRoot,
  findCardById,
  makeCardsFor,
  resolveGitRootForCwd,
  toolTextAllowed,
  type StoredBlock,
  type StoredCard,
  type StoredFlowStep,
} from "../desk/cards-read.js";
import { cardsFilePath } from "../listening/cards-path.js";

function makeTempDir(t: { after(fn: () => void): void }, prefix = "rocky-cards-root-"): string {
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
    quote: { text: "keep invariant", shared: false },
    ...overrides,
  };
}

function makeStep(overrides: Partial<StoredFlowStep> = {}): StoredFlowStep {
  return {
    kind: "cmd",
    text: "npm test",
    ok: true,
    dur_ms: 120,
    seqs: [1],
    start_ms: 1000,
    end_ms: 1120,
    cwd: "/work/repo/sub",
    tool_use_id: "toolu_1",
    desc: "Run test suite",
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
    prompt: "Update target",
    prompt_truncated: false,
    importance: "medium",
    blocks,
    more_count: 0,
    flow: [makeStep()],
    flow_more: 0,
    outside_count: 0,
    coverage: { state: "complete", reasons: [] },
    ...overrides,
  };
}

function writeJsonl(filePath: string, entries: readonly unknown[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const text = entries.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))).join("\n") + "\n";
  writeFileSync(filePath, text, "utf8");
}

function makeRepo(baseDir: string, name = "repo"): { repoRoot: string; subDir: string } {
  const repoRoot = join(baseDir, name);
  const subDir = join(repoRoot, "packages", "app");
  mkdirSync(join(repoRoot, ".git"), { recursive: true });
  mkdirSync(subDir, { recursive: true });
  return { repoRoot, subDir };
}

test("cardsForRoot returns latest revision per card_id with complete coverage for repo root and subdirs", (t) => {
  const temp = makeTempDir(t);
  const home = join(temp, "home");
  const { repoRoot, subDir } = makeRepo(temp, "repo-a");
  const { repoRoot: otherRepo } = makeRepo(temp, "repo-b");
  const canonicalRoot = canonicalPath(repoRoot);
  const canonicalOther = canonicalPath(otherRepo);

  writeJsonl(cardsFilePath(canonicalRoot, home), [
    makeCard("card-1", canonicalRoot, [makeBlock(1, "src/a.ts")], { rev: 1, prompt: "old rev", ended_ms: 1500 }),
    makeCard("card-1", canonicalRoot, [makeBlock(1, "src/a.ts")], { rev: 3, prompt: "latest rev", ended_ms: 3000 }),
    makeCard("card-1", canonicalRoot, [makeBlock(1, "src/a.ts")], { rev: 2, prompt: "stale rev", ended_ms: 2500 }),
    makeCard("card-2", canonicalRoot, [makeBlock(1, "src/b.ts")], { rev: 1, ended_ms: 4000 }),
  ]);
  writeJsonl(cardsFilePath(canonicalOther, home), [
    makeCard("card-other", canonicalOther, [makeBlock(1, "src/other.ts")], { rev: 1, ended_ms: 5000 }),
  ]);

  const fromRoot = cardsForRoot(repoRoot, { home, toolText: true });
  assert.equal(fromRoot.complete, true);
  assert.deepEqual(
    fromRoot.cards.map((c) => c.card_id),
    ["card-2", "card-1"],
  );
  assert.equal(fromRoot.cards[1]?.rev, 3);
  assert.equal(fromRoot.cards[1]?.prompt, "latest rev");
  assert.equal(fromRoot.cards[1]?.flow?.[0]?.desc, "Run test suite");
  assert.equal(fromRoot.cards[1]?.blocks[0]?.quote?.text, "keep invariant");

  const fromSub = cardsForRoot(subDir, { home, toolText: true });
  assert.equal(fromSub.complete, true);
  assert.deepEqual(
    fromSub.cards.map((c) => c.card_id),
    ["card-2", "card-1"],
  );
});

test("cardsForRoot with toolText: false strips desc from steps and quote from blocks", (t) => {
  const temp = makeTempDir(t);
  const home = join(temp, "home");
  const { repoRoot } = makeRepo(temp);
  const canonicalRoot = canonicalPath(repoRoot);

  writeJsonl(cardsFilePath(canonicalRoot, home), [
    makeCard("card-1", canonicalRoot, [makeBlock(1, "src/a.ts", { quote: { text: "secret note", shared: false } })], {
      flow: [makeStep({ desc: "Run secret command", cwd: "/work/repo/sub", tool_use_id: "toolu_9" })],
    }),
  ]);

  const redacted = cardsForRoot(repoRoot, { home, toolText: false });
  assert.equal(redacted.complete, true);
  assert.equal(redacted.cards.length, 1);
  const card = redacted.cards[0]!;
  assert.equal("quote" in card.blocks[0]!, false);
  assert.equal(card.blocks[0]?.quote, undefined);
  assert.equal("desc" in card.flow![0]!, false);
  assert.equal(card.flow?.[0]?.desc, undefined);
  assert.equal(card.flow?.[0]?.tool_use_id, "toolu_9");
  assert.equal(card.flow?.[0]?.cwd, "/work/repo/sub");

  const allowed = cardsForRoot(repoRoot, { home, toolText: true });
  assert.equal(allowed.cards[0]?.blocks[0]?.quote?.text, "secret note");
  assert.equal(allowed.cards[0]?.flow?.[0]?.desc, "Run secret command");
});

test("cardsForRoot reads _none.jsonl when cwd is outside any repo", (t) => {
  const temp = makeTempDir(t);
  const home = join(temp, "home");
  const outsideDir = join(temp, "not-a-repo");
  mkdirSync(outsideDir, { recursive: true });

  const noneLog = join(home, "desk", "cards", "_none.jsonl");
  writeJsonl(noneLog, [
    makeCard("none-1", "", [makeBlock(1, join(outsideDir, "note.md"))], { rev: 1, ended_ms: 1000 }),
    makeCard("none-1", "", [makeBlock(1, join(outsideDir, "note.md"))], { rev: 2, prompt: "rev 2", ended_ms: 2000 }),
  ]);

  const result = cardsForRoot(outsideDir, { home, toolText: true });
  assert.equal(result.complete, true);
  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0]?.card_id, "none-1");
  assert.equal(result.cards[0]?.rev, 2);
  assert.equal(result.cards[0]?.prompt, "rev 2");

  const emptyHome = join(temp, "empty-home");
  const missing = cardsForRoot(outsideDir, { home: emptyHome, toolText: true });
  assert.deepEqual(missing, { cards: [], complete: true });
});

test("cardsForRoot reports complete: false when the own log has skipped lines", (t) => {
  const temp = makeTempDir(t);
  const home = join(temp, "home");
  const { repoRoot } = makeRepo(temp);
  const canonicalRoot = canonicalPath(repoRoot);

  writeJsonl(cardsFilePath(canonicalRoot, home), [
    "{broken",
    makeCard("card-ok", canonicalRoot, [makeBlock(1, "src/a.ts")]),
  ]);

  const result = cardsForRoot(repoRoot, { home, toolText: true });
  assert.equal(result.complete, false);
  assert.deepEqual(
    result.cards.map((c) => c.card_id),
    ["card-ok"],
  );
});

test("findCardById finds highest rev across all card logs, strips when toolText is false, and returns undefined for unknown", (t) => {
  const temp = makeTempDir(t);
  const home = join(temp, "home");
  const { repoRoot: repoA } = makeRepo(temp, "repo-a");
  const { repoRoot: repoB } = makeRepo(temp, "repo-b");

  writeJsonl(cardsFilePath(canonicalPath(repoA), home), [
    makeCard("target-card", canonicalPath(repoA), [makeBlock(1, "src/a.ts")], { rev: 2, prompt: "rev 2 in A" }),
    makeCard("only-a", canonicalPath(repoA), [makeBlock(1, "src/a.ts")], { rev: 1 }),
  ]);
  writeJsonl(cardsFilePath(canonicalPath(repoB), home), [
    makeCard("target-card", canonicalPath(repoB), [makeBlock(1, "src/b.ts")], { rev: 4, prompt: "rev 4 in B" }),
    makeCard("target-card", canonicalPath(repoB), [makeBlock(1, "src/b.ts")], { rev: 3, prompt: "rev 3 in B" }),
  ]);
  writeJsonl(join(home, "desk", "cards", "_none.jsonl"), [
    makeCard("in-none", "", [makeBlock(1, "/tmp/x.txt")], { rev: 1 }),
  ]);

  const found = findCardById("target-card", { home, toolText: true });
  assert.ok(found);
  assert.equal(found.rev, 4);
  assert.equal(found.prompt, "rev 4 in B");
  assert.equal(found.blocks[0]?.quote?.text, "keep invariant");
  assert.equal(found.flow?.[0]?.desc, "Run test suite");

  const stripped = findCardById("target-card", { home, toolText: false });
  assert.ok(stripped);
  assert.equal(stripped.rev, 4);
  assert.equal("quote" in stripped.blocks[0]!, false);
  assert.equal("desc" in stripped.flow![0]!, false);

  const fromNone = findCardById("in-none", { home, toolText: true });
  assert.equal(fromNone?.card_id, "in-none");

  assert.equal(findCardById("does-not-exist", { home, toolText: true }), undefined);
  assert.equal(findCardById("target-card", { home: join(temp, "no-cards-home"), toolText: true }), undefined);
});

test("toolTextAllowed returns false when <home>/desk/tool-text-off exists and true otherwise", (t) => {
  const temp = makeTempDir(t);
  const home = join(temp, "home");

  assert.equal(toolTextAllowed(home), true);

  mkdirSync(join(home, "desk"), { recursive: true });
  assert.equal(toolTextAllowed(home), true);

  writeFileSync(join(home, "desk", "tool-text-off"), "", "utf8");
  assert.equal(toolTextAllowed(home), false);
});

test("cardsForRoot does not trim trailing-space cwd into a sibling nested repo", (t) => {
  if (process.platform === "win32") {
    t.skip("trailing-space directory names are not distinct from trimmed siblings on win32");
    return;
  }
  const temp = makeTempDir(t);
  const home = join(temp, "home");
  const parentRepo = join(temp, "project");
  const nestedRepo = join(parentRepo, "pkg");
  const trailingSpaceSubdir = join(parentRepo, "pkg ");
  mkdirSync(join(parentRepo, ".git"), { recursive: true });
  mkdirSync(join(nestedRepo, ".git"), { recursive: true });
  mkdirSync(trailingSpaceSubdir, { recursive: true });

  const parentCanon = canonicalPath(parentRepo);
  const nestedCanon = canonicalPath(nestedRepo);
  writeJsonl(cardsFilePath(parentCanon, home), [
    makeCard("card-parent", parentCanon, [makeBlock(1, "src/parent.ts")], { ended_ms: 2000 }),
  ]);
  writeJsonl(cardsFilePath(nestedCanon, home), [
    makeCard("card-nested", nestedCanon, [makeBlock(1, "src/nested.ts")], { ended_ms: 3000 }),
  ]);

  const result = cardsForRoot(trailingSpaceSubdir, { home, toolText: true });
  assert.equal(result.complete, true);
  assert.deepEqual(
    result.cards.map((c) => c.card_id),
    ["card-parent"],
  );
});

test("resolveGitRootForCwd preserves trailing whitespace instead of probing a trimmed sibling repo", () => {
  const base = process.platform === "win32" ? "C:\\work\\project" : "/work/project";
  const basePosix = base.replace(/\\/g, "/");
  const parentGit = `${basePosix}/.git`;
  const nestedGit = `${basePosix}/pkg/.git`;
  const exists = (p: string): boolean => {
    const norm = p.replace(/\\/g, "/");
    return norm === parentGit || norm === nestedGit || norm === `${basePosix}/pkg `;
  };
  assert.equal(resolveGitRootForCwd(join(base, "pkg "), exists), basePosix);
});

test("resolveGitRootForCwd keeps Windows drive roots absolute so their log key matches C:/", (t) => {
  if (process.platform !== "win32") {
    t.skip("drive-root spelling is win32-specific");
    return;
  }
  const temp = makeTempDir(t);
  const home = join(temp, "home");
  const driveGitOnly = (p: string): boolean => p.replace(/\\/g, "/").toLowerCase() === "c:/.git";

  for (const cwd of ["C:\\", "C:/", "C:\\sub\\dir"]) {
    const root = resolveGitRootForCwd(cwd, driveGitOnly);
    assert.equal(root, "C:/");
    assert.equal(canonicalPath(root), canonicalPath("C:/"));
    assert.equal(cardsFilePath(canonicalPath(root), home), cardsFilePath(canonicalPath("C:/"), home));
    assert.notEqual(cardsFilePath(canonicalPath(root), home), cardsFilePath(canonicalPath("C:"), home));
  }
});

test("makeCardsFor caches per git root across subdirectories, respects toolText, and falls back to cwd outside a repo", (t) => {
  const temp = makeTempDir(t);
  const home = join(temp, "home");
  const { repoRoot, subDir } = makeRepo(temp, "cached-repo");
  const outsideDir = join(temp, "outside");
  mkdirSync(outsideDir, { recursive: true });
  const canonicalRoot = canonicalPath(repoRoot);

  writeJsonl(cardsFilePath(canonicalRoot, home), [
    makeCard("card-cached", canonicalRoot, [makeBlock(1, "src/a.ts", { quote: { text: "note", shared: false } })], {
      flow: [makeStep({ desc: "Run tests" })],
    }),
  ]);
  writeJsonl(join(home, "desk", "cards", "_none.jsonl"), [
    makeCard("card-none", "", [makeBlock(1, join(outsideDir, "a.txt"))]),
  ]);

  const cardsFor = makeCardsFor({ home, toolText: false });
  const fromRoot = cardsFor(repoRoot);
  const fromSub = cardsFor(subDir);
  assert.equal(fromSub, fromRoot, "repo root and subdir should share the cached result");
  assert.equal(fromRoot.complete, true);
  assert.equal(fromRoot.cards.length, 1);
  assert.equal(fromRoot.cards[0]?.card_id, "card-cached");
  assert.equal(fromRoot.cards[0]?.blocks[0]?.quote, undefined);
  assert.equal(fromRoot.cards[0]?.flow?.[0]?.desc, undefined);

  const outsideFirst = cardsFor(outsideDir);
  const outsideSecond = cardsFor(outsideDir);
  assert.equal(outsideSecond, outsideFirst);
  assert.equal(outsideFirst.cards[0]?.card_id, "card-none");
});
