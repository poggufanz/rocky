import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gitRootFor,
  trueCaseRel,
  parsePatch,
  diffFor,
  fileIndex,
  type CompareRec,
  type DiffRow,
  type FileEntry,
} from "../ui/tui/surface/compare-data.js";
import type { MemoryRecord } from "../core/memory-read.js";

test("gitRootFor walks up to the nearest .git and anchors relative paths", () => {
  const fs = new Set(["/w", "/w/rocky", "/w/rocky/.git", "/w/rocky/src", "/w/docs"]);
  const exists = (p: string) => fs.has(p.replace(/\\/g, "/").replace(/\/+$/, ""));
  assert.equal(gitRootFor("/w/rocky/src/deep/f.ts", exists)?.replace(/\\/g, "/"), "/w/rocky");
  assert.equal(gitRootFor("/w/docs/x.md", exists), undefined);
});

test("trueCaseRel canonicalizes against ls-files case-insensitively", () => {
  const ls = () => ["CHANGELOG.md", "src/Core/Memory.ts"];
  assert.equal(trueCaseRel("/r", "changelog.md", ls), "CHANGELOG.md");
  assert.equal(trueCaseRel("/r", "src/core/memory.ts", ls), "src/Core/Memory.ts");
  assert.equal(trueCaseRel("/r", "unknown.md", ls), "unknown.md");
});

test("parsePatch numbers both gutters through hunks", () => {
  const rows = parsePatch([
    "diff --git a/f b/f", "--- a/f", "+++ b/f",
    "@@ -2,3 +2,4 @@", " ctx", "-old", "+new1", "+new2", " tail",
  ].join("\n"));
  const adds = rows.filter((r: DiffRow) => r.k === "+");
  assert.deepEqual(adds.map((r: DiffRow) => r.n), [3, 4]);
  const del = rows.find((r: DiffRow) => r.k === "-");
  assert.equal(del?.o, 3);
  const ctx = rows.filter((r: DiffRow) => r.k === " ");
  assert.deepEqual(ctx.map((r: DiffRow) => [r.o, r.n]), [[2, 2], [4, 5]]);
});

test("diffFor ladder: no root refuses, head resolves, fallback labels prior", () => {
  const rec: CompareRec = { kind: "triple", ts: 1000, cwd: "/w/rocky", source: "", machine: false, head: "abc" };
  const io = {
    exists: (p: string) => ["/w/rocky", "/w/rocky/.git", "/w/rocky/src"].includes(p.replace(/\\/g, "/").replace(/\/+$/, "")),
    lsFiles: () => ["src/f.ts"],
    resolve: (o: { ts: number; head?: string; file: string; cwd: string }) =>
      o.head === "abc"
        ? undefined
        : { commit: "prior12", diff: "--- a/src/f.ts\n+++ b/src/f.ts\n@@ -1,1 +1,1 @@\n-a\n+b" },
    lastShaBefore: () => "prior-sha",
  };
  const outside = diffFor("/elsewhere/f.ts", rec, { ...io, exists: () => false });
  assert.equal(outside.rows[0].k, "m");
  assert.match(outside.rows[0].t, /no \.git/);
  const hit = diffFor("/w/rocky/src/f.ts", rec, io);
  assert.equal(hit.prior, true);
  assert.equal(hit.commit, "prior12");
  assert.ok(hit.rows.some((r: DiffRow) => r.k === "+"));
});

test("diffFor appends excerpt lines when git diff is unavailable or refused", () => {
  const rec: CompareRec = {
    kind: "triple",
    ts: 1000,
    cwd: "/w/rocky",
    source: "",
    machine: false,
    excerpt: "const x = 1;\nconst y = 2;",
  };
  const io = {
    exists: () => false,
    lsFiles: () => [],
    resolve: () => undefined,
    lastShaBefore: () => "",
  };
  const res = diffFor("/w/rocky/src/f.ts", rec, io);
  assert.equal(res.rows[0].k, "m");
  assert.match(res.rows[0].t, /no \.git/);
  const excerptHeader = res.rows.find((r: DiffRow) => r.t === "excerpt rocky kept:");
  assert.ok(excerptHeader);
  const xRows = res.rows.filter((r: DiffRow) => r.k === "x");
  assert.equal(xRows.length, 2);
  assert.equal(xRows[0].t, "const x = 1;");
});

test("fileIndex indexes files across multiple records and sorts by count descending", () => {
  const records: MemoryRecord[] = [
    {
      v: 1,
      kind: "triple",
      id: "t1",
      ts: 1000,
      cwd: "/repo",
      schemaV: 1,
      agent: "claude-code",
      origin: "agent-hook",
      intent: { text: "Fix database pool connection timeout" },
      mechanism: {
        head: "commit1",
        files: [
          { path: "src/db.ts", plusMinus: [5, 2], props: [], excerpt: "pool.connect()" },
          { path: "/repo/src/config.ts", plusMinus: [1, 0], props: [] },
        ],
        truncatedFiles: 0,
        coverageStatus: "complete",
      },
    } as any,
    {
      v: 1,
      kind: "triple",
      id: "t2",
      ts: 2000,
      cwd: "/repo",
      schemaV: 1,
      agent: "claude-code",
      origin: "agent-hook",
      intent: { text: "<task-notification><task-id>task-1</task-id><summary>Agent review</summary></task-notification>" },
      mechanism: {
        head: "commit2",
        files: [
          { path: "src/db.ts", plusMinus: [10, 1], props: [] },
        ],
        truncatedFiles: 0,
        coverageStatus: "complete",
      },
    } as any,
    {
      kind: "note",
      id: "n1",
      ts: 3000,
      cwd: "/repo",
      cmd: "rocky",
      file: "docs/readme.md",
      line: 10,
      subject: "setup",
      answer: "use npm install",
    } as any,
  ];

  const index = fileIndex(records);
  assert.equal(index.length, 3);

  // src/db.ts has 2 records -> top entry
  const dbEntry = index[0];
  assert.equal(dbEntry.path, "/repo/src/db.ts");
  assert.equal(dbEntry.count, 2);
  assert.equal(dbEntry.firstTs, 1000);
  assert.equal(dbEntry.lastTs, 2000);
  assert.equal(dbEntry.recs.length, 2);
  assert.equal(dbEntry.recs[0].ts, 2000); // ts descending
  assert.equal(dbEntry.recs[0].machine, true);
  assert.equal(dbEntry.recs[0].summary, "Agent review");
  assert.equal(dbEntry.recs[1].ts, 1000);
  assert.equal(dbEntry.recs[1].machine, false);
  assert.equal(dbEntry.recs[1].plus, 5);
  assert.equal(dbEntry.recs[1].minus, 2);
  assert.equal(dbEntry.recs[1].excerpt, "pool.connect()");

  // docs/readme.md is anchored to cwd
  const readmeEntry = index.find((f: FileEntry) => f.path.endsWith("docs/readme.md"));
  assert.ok(readmeEntry);
  assert.equal(readmeEntry.path, "/repo/docs/readme.md");
  assert.equal(readmeEntry.count, 1);
});

test("integration: diffFor with real temporary git repository", () => {
  const dir = mkdtempSync(join(tmpdir(), "rocky-compare-test-"));
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: dir, encoding: "utf8" });
    execFileSync("git", ["config", "user.name", "Rocky Tester"], { cwd: dir, encoding: "utf8" });
    execFileSync("git", ["config", "user.email", "rocky@example.com"], { cwd: dir, encoding: "utf8" });

    mkdirSync(join(dir, "src"), { recursive: true });
    const filePath = join(dir, "src", "hello.ts");
    writeFileSync(filePath, "console.log('v1');\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: dir, encoding: "utf8" });
    execFileSync("git", ["commit", "-m", "initial commit"], { cwd: dir, encoding: "utf8" });
    const head1 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();

    writeFileSync(filePath, "console.log('v2');\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: dir, encoding: "utf8" });
    execFileSync("git", ["commit", "-m", "second commit"], { cwd: dir, encoding: "utf8" });
    const head2 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();

    const now = Date.now();
    const rec: CompareRec = {
      kind: "triple",
      ts: now,
      cwd: dir,
      source: "agent",
      machine: false,
      head: head2,
    };

    const io = {
      exists: (p: string) => {
        try {
          execFileSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", stdio: "pipe" });
          return true;
        } catch {
          return false;
        }
      },
      lsFiles: (root: string) => {
        return execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
      },
      resolve: (opts: { ts: number; head?: string; file: string; cwd: string }) => {
        if (!opts.head) return undefined;
        try {
          const diff = execFileSync("git", ["-C", opts.cwd, "diff-tree", "-p", "-U2", opts.head, "--", opts.file], { encoding: "utf8" });
          return diff.trim() ? { commit: opts.head.slice(0, 7), diff } : undefined;
        } catch {
          return undefined;
        }
      },
      lastShaBefore: (root: string, rel: string, tsIso: string) => {
        try {
          return execFileSync("git", ["-C", root, "log", "-n", "1", "--format=%H", `--until=${tsIso}`, "--", rel], { encoding: "utf8" }).trim();
        } catch {
          return "";
        }
      },
    };

    const res = diffFor(filePath, rec, io);
    assert.equal(res.commit, head2.slice(0, 7));
    assert.ok(res.rows.some((r: DiffRow) => r.k === "+" && r.t.includes("console.log('v2')")));
    assert.ok(res.rows.some((r: DiffRow) => r.k === "-" && r.t.includes("console.log('v1')")));
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});
