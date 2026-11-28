import assert from "node:assert/strict";
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { editJsoncPathAtomic } from "../../setup/json-config.js";

function fixture(t: TestContext, original?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rocky-jsonc-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, "opencode.jsonc");
  if (original !== undefined) writeFileSync(target, original, "utf8");
  return target;
}

test("editJsoncPathAtomic preserves comments and trailing commas byte-identically outside edit range", async (t) => {
  const preserved = [
    "{",
    "\t// user comment before  ",
    '\t"theme"  : "dark",',
    "\t/* block comment */",
    '\t"plugin": [',
    '\t\t"existing-plugin",',
    "\t],",
    "",
  ].join("\r\n");
  const target = fixture(t, `${preserved}}\r\n`);

  const result = await editJsoncPathAtomic(target, ["mcp", "rocky"], { command: "rocky", args: ["mcp"] });
  assert.equal(result.status, "written");
  assert.equal(readFileSync(target, "utf8"), preserved + [
    '\t"mcp": {',
    '\t\t"rocky": {',
    '\t\t\t"command": "rocky",',
    '\t\t\t"args": [',
    '\t\t\t\t"mcp"',
    "\t\t\t]",
    "\t\t}",
    "\t},",
    "}",
    "",
  ].join("\r\n"));

  const removed = await editJsoncPathAtomic(target, ["mcp", "rocky"], undefined);
  assert.equal(removed.status, "written");
  assert.equal(readFileSync(target, "utf8"), `${preserved}\t"mcp": {\r\n\t},\r\n}\r\n`);
});

test("deleting an only property with a trailing comma leaves a valid empty object", async (t) => {
  const target = fixture(t, '{\n  "mcp": {\n    "rocky": true,\n  },\n  "other": [1,],\n}\n');
  assert.equal((await editJsoncPathAtomic(target, ["mcp", "rocky"], undefined)).status, "written");
  assert.equal(readFileSync(target, "utf8"), '{\n  "mcp": {\n  },\n  "other": [1,],\n}\n');
});

test("deleting an object property preserves adjacent comments byte for byte", async (t) => {
  for (const [before, after] of [
    ['{"keep": 1 /* keep comment */, "rocky": true}', '{"keep": 1 /* keep comment */ }'],
    ['{"rocky": true, /* keep comment */ "keep": 1}', '{ /* keep comment */ "keep": 1}'],
    ['{"keep":1, "rocky": true, // next comment\r\n "next":2}', '{"keep":1,  // next comment\r\n "next":2}'],
  ]) {
    const target = fixture(t, before);
    assert.equal((await editJsoncPathAtomic(target, ["rocky"], undefined)).status, "written");
    assert.deepEqual(readFileSync(target), Buffer.from(after));
  }
});

test("a retried JSONC edit recovers a displaced original and refuses recovery if it is gone", async (t) => {
  const original = '{/* untouched */"keep":1}\n';
  for (const state of ["prepared", "displaced", "original-gone"] as const) {
    const target = fixture(t, original);
    const transaction = join(dirname(target), `.${basename(target)}.transaction-interrupted`);
    fs.mkdirSync(transaction);
    writeFileSync(join(transaction, "manifest.json"), JSON.stringify({
      version: 1, target, state: state === "original-gone" ? "displaced" : state,
    }));
    fs.renameSync(target, join(transaction, "displaced"));
    if (state === "original-gone") {
      fs.unlinkSync(join(transaction, "displaced"));
      const result = await editJsoncPathAtomic(target, ["rocky"], true);
      assert.equal(result.status, "recovery-required");
      assert.equal(result.recoveryPath, transaction);
      assert.equal(fs.existsSync(target), false);
    } else {
      writeFileSync(join(transaction, "prepared"), '{"unpublished":true}\n');
      assert.equal((await editJsoncPathAtomic(target, ["rocky"], true, {
        mutationGuard: { unchanged: () => false },
      })).status, "recovery-required");
      assert.equal(fs.existsSync(target), false);
      assert.equal(readFileSync(join(transaction, "displaced"), "utf8"), original);
      assert.equal((await editJsoncPathAtomic(target, ["rocky"], true)).status, "written");
      assert.equal(readFileSync(target, "utf8"), '{/* untouched */"keep":1,"rocky": true}\n');
    }
  }
});

test("deleting the last item from a compact array removes the entire value", async (t) => {
  const target = fixture(t, '{"values":[1,23]}\n');
  assert.equal((await editJsoncPathAtomic(target, ["values", 1], undefined)).status, "written");
  assert.equal(readFileSync(target, "utf8"), '{"values":[1]}\n');
});

test("deleting the last array item preserves the preceding item's comment and whitespace", async (t) => {
  const target = fixture(t, '{"values":[1 /* keep this note */, 23]}\n');
  assert.equal((await editJsoncPathAtomic(target, ["values", 1], undefined)).status, "written");
  assert.equal(readFileSync(target, "utf8"), '{"values":[1 /* keep this note */ ]}\n');
});

test("inserting into a compact object preserves an existing sibling byte-for-byte", async (t) => {
  const target = fixture(t, '{"keep"  :  1}\n');
  assert.equal((await editJsoncPathAtomic(target, ["added"], 2)).status, "written");
  assert.equal(readFileSync(target, "utf8"), '{"keep"  :  1,"added": 2}\n');
});

test("inserting into a multiline object formats the new property without changing its sibling", async (t) => {
  const target = fixture(t, '{\n  "keep"  :  1\n}\n');
  assert.equal((await editJsoncPathAtomic(target, ["added"], 2)).status, "written");
  assert.equal(readFileSync(target, "utf8"), '{\n  "keep"  :  1,\n  "added": 2\n}\n');
});

test("setting an empty root object creates a missing config file", async (t) => {
  const target = fixture(t);
  assert.equal(fs.existsSync(target), false);
  assert.equal((await editJsoncPathAtomic(target, [], {})).status, "written");
  assert.equal(readFileSync(target, "utf8"), "{}\n");
});

test("editing malformed JSONC refuses to replace the original bytes", async (t) => {
  const original = '{"theme": /* unfinished';
  const target = fixture(t, original);
  await assert.rejects(editJsoncPathAtomic(target, ["theme"], "light"), /JSON config is invalid/);
  assert.equal(readFileSync(target, "utf8"), original);
});

function failDisplacement(
  t: TestContext,
  target: string,
  shouldFail: (attempt: number) => boolean,
  code = "EPERM",
): () => number {
  const rename = fs.renameSync;
  let attempts = 0;
  fs.renameSync = (from, to) => {
    if (from === target && basename(String(to)) === "displaced" && shouldFail(++attempts)) {
      throw Object.assign(new Error("rename temporarily refused"), { code });
    }
    rename(from, to);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.renameSync = rename;
    syncBuiltinESMExports();
  });
  return () => attempts;
}

test("Windows retries two EPERM displacement failures while checking the mutation guard", { skip: process.platform !== "win32" }, async (t) => {
  const target = fixture(t, '{"theme":"dark"}\n');
  let guardCheckedAt = -1;
  const attempts = failDisplacement(t, target, (attempt) => {
    assert.equal(guardCheckedAt, attempt - 1);
    return attempt <= 2;
  });
  const result = await editJsoncPathAtomic(target, ["theme"], "light", {
    mutationGuard: { unchanged() { guardCheckedAt = attempts(); return true; } },
  });
  assert.equal(result.status, "written");
  assert.equal(attempts(), 3);
  assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { theme: "light" });
});

test("a persistent EBUSY fails after five attempts on Windows and one elsewhere", async (t) => {
  const original = '{"theme":"dark"}\n';
  const target = fixture(t, original);
  const attempts = failDisplacement(t, target, () => true, "EBUSY");
  await assert.rejects(editJsoncPathAtomic(target, ["theme"], "light"), /Unable to write JSON config/);
  assert.equal(attempts(), process.platform === "win32" ? 5 : 1);
  assert.equal(readFileSync(target, "utf8"), original);
});

test("Windows stops retrying when the mutation guard loses authority", { skip: process.platform !== "win32" }, async (t) => {
  const original = '{"theme":"dark"}\n';
  const target = fixture(t, original);
  const attempts = failDisplacement(t, target, () => true);
  const result = await editJsoncPathAtomic(target, ["theme"], "light", {
    mutationGuard: { unchanged: () => attempts() === 0 },
  });
  assert.equal(result.status, "recovery-required");
  assert.equal(attempts(), 1);
  assert.equal(readFileSync(target, "utf8"), original);
});

test("Windows stops retrying when a junction replaces the regular file", { skip: process.platform !== "win32" }, async (t) => {
  const original = '{"theme":"dark"}\n';
  const target = fixture(t, original);
  const prior = `${target}.original`;
  const directory = `${target}.directory`;
  fs.mkdirSync(directory);
  const rename = fs.renameSync;
  const attempts = failDisplacement(t, target, (attempt) => {
    if (attempt > 1) return false;
    rename(target, prior);
    fs.symlinkSync(directory, target, "junction");
    return true;
  });
  const result = await editJsoncPathAtomic(target, ["theme"], "light");
  assert.equal(result.status, "changed");
  assert.equal(attempts(), 1);
  assert.ok(fs.lstatSync(target).isSymbolicLink());
  assert.equal(readFileSync(prior, "utf8"), original);
});
