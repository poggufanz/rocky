import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileIndex, plausibleFilePath } from "../core/compare-data.js";

test("plausibleFilePath keeps ordinary paths", () => {
  assert.equal(plausibleFilePath("src/a.ts"), true);
  assert.equal(plausibleFilePath("C:/work/repo/a.ts"), true);
  assert.equal(plausibleFilePath("docs/weird name.md"), true);
});

test("plausibleFilePath rejects shell fragments an agent never expanded", () => {
  assert.equal(plausibleFilePath("$(echo src/a.ts | tr / '/')"), false);
  assert.equal(plausibleFilePath("')"), false);
  assert.equal(plausibleFilePath("C:/work/repo$(echo a.ts | tr / '/')"), false);
});

test("fileIndex never lists a shell fragment as a heard file", () => {
  const records = [{
    kind: "rationale", id: "r1", ts: 1, v: 1, cwd: "/repo", agent: "generic",
    rationale_fidelity: "summary", source: "notify", excerpt: "x",
    files: ["/repo/$(echo src/a.ts | tr / '/')", "/repo/src/real.ts"],
  }];
  const paths = fileIndex(records as never).map((f) => f.path);
  assert.deepEqual(paths, ["/repo/src/real.ts"]);
});

test("recordRationale drops shell-fragment file entries instead of storing them", async () => {
  process.env.ROCKY_HOME = realpathSync(mkdtempSync(join(tmpdir(), "rocky-pp-")));
  const { recordRationale } = await import("../core/memory.js");
  const rec = recordRationale({
    cwd: "/repo", agent: "generic", rationale_fidelity: "summary", source: "notify",
    text: "why", files: ["src/real.ts", "$(echo src/a.ts | tr / '/')"],
  });
  assert.deepEqual(rec.files, ["src/real.ts"]);
});

test("recordRationale omits files when every entry is a shell fragment", async () => {
  process.env.ROCKY_HOME = realpathSync(mkdtempSync(join(tmpdir(), "rocky-pp2-")));
  const { recordRationale } = await import("../core/memory.js");
  const rec = recordRationale({
    cwd: "/repo", agent: "generic", rationale_fidelity: "summary", source: "notify",
    text: "why", files: ["')", "$(echo a.ts)"],
  });
  assert.equal(rec.files, undefined);
});

test("fileIndex reads explain code into reason", () => {
  const records = [{
    kind: "explain", id: "e1", ts: 1, v: 1, cwd: "/repo",
    path: "src/a.ts", source: "agent:generic",
    code: "async because two IO calls run in sequence",
    business: "journal accepts DOCENTRY only",
  }];
  const entry = fileIndex(records as never).find((f) => f.path === "/repo/src/a.ts");
  assert.ok(entry);
  assert.equal(entry.recs[0]?.reason, "async because two IO calls run in sequence");
});

test("fileIndex falls back to business then snippet", () => {
  const records = [
    {
      kind: "explain", id: "e2", ts: 2, v: 1, cwd: "/repo",
      path: "src/b.ts", source: "agent:generic",
      code: "", business: "approval page needs manager sign-off",
    },
    {
      kind: "explain", id: "e3", ts: 3, v: 1, cwd: "/repo",
      path: "src/c.ts", source: "agent:generic",
      code: "", business: "", snippet: "const x = await load();",
    },
  ];
  const byPath = new Map(fileIndex(records as never).map((f) => [f.path, f]));
  assert.equal(byPath.get("/repo/src/b.ts")?.recs[0]?.reason, "approval page needs manager sign-off");
  assert.equal(byPath.get("/repo/src/c.ts")?.recs[0]?.reason, "const x = await load();");
});

