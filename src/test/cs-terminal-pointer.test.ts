import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { teach } from "../commands/teach.js";
import { conceptsCommand } from "../commands/concepts.js";
import { recordExplain } from "../core/memory.js";
import { resolveRockyPaths } from "../core/state-paths.js";

test("teach adds one CS pointer line on loop file, quiet suppresses", async () => {
  const home = mkdtempSync(join(tmpdir(), "rocky-cs-pointer-"));
  process.env.ROCKY_HOME = home;
  const dir = mkdtempSync(join(tmpdir(), "rocky-cs-src-"));
  const path = join(dir, "loop.js");
  writeFileSync(path, "// loop iteration\nfor (let i = 0; i < 3; i += 1) {\n  total += await fetch(i);\n}\n", "utf8");
  const detailLines: string[] = [];
  const deps = {
    say: () => {},
    heading: () => {},
    block: () => {},
    detail: (l: string) => { detailLines.push(l); },
  };
  await teach([`${path}:3`], deps);
  assert.ok(detailLines.some((l) => l.includes("cs concept") && l.includes("dash")));
  const quietLines: string[] = [];
  await teach([`${path}:3`, "--quiet"], {
    say: () => {}, heading: () => {}, block: () => {},
    detail: (l: string) => { quietLines.push(l); },
  });
  assert.ok(!quietLines.some((l) => l.includes("cs concept")));
});

test("teach adds CS pointer line on witness card", async () => {
  const home = mkdtempSync(join(tmpdir(), "rocky-cs-witness-"));
  process.env.ROCKY_HOME = home;
  const dir = mkdtempSync(join(tmpdir(), "rocky-cs-src-"));
  const path = join(dir, "loop.js");
  const code = "// loop iteration\nfor (let i = 0; i < 3; i += 1) {\n  total += await fetch(i);\n}\n";
  writeFileSync(path, code, "utf8");
  recordExplain({
    cwd: process.cwd(),
    path,
    source: "agent:test",
    code: "loop iteration break condition",
    business: "loop",
    snippet: code.trim(),
  }, resolveRockyPaths());
  const detailLines: string[] = [];
  await teach([`${path}:1`], {
    say: () => {}, heading: () => {}, block: () => {},
    detail: (l: string) => { detailLines.push(l); },
  });
  assert.ok(detailLines.some((l) => l.includes("cs concept control-flow") && l.includes("dash")));
});

test("concepts reverse lookup exits 0 for CS concept", () => {
  const home = mkdtempSync(join(tmpdir(), "rocky-cs-concept-"));
  process.env.ROCKY_HOME = home;
  assert.equal(conceptsCommand(["control-flow"]), 0);
});

test("concepts reverse lookup exits 0 for CS concept with evidence", () => {
  const home = mkdtempSync(join(tmpdir(), "rocky-cs-concept-ev-"));
  process.env.ROCKY_HOME = home;
  writeFileSync(join(home, "memory.jsonl"), JSON.stringify({
    kind: "triple", id: "t1", ts: Date.now(), cwd: process.cwd(), schemaV: 1, agent: "claude-code", origin: "agent-hook",
    intent: { text: "loop iteration breaks on condition" }, mechanism: { files: [], truncatedFiles: 0 },
  }) + "\n", "utf8");
  assert.equal(conceptsCommand(["control-flow"]), 0);
});
