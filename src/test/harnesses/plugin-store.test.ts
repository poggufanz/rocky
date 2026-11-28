import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, {
  lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { removeManagedPluginFile, writeManagedPluginFile } from "../../harnesses/shared/plugin-file-store.js";
import { codexNotifySnippet, detectCodexInlineHooksConflict } from "../../harnesses/shared/toml-snippet.js";

test("a Rocky header does not authorize removal or overwrite after content changes", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rocky-plugin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "hook.js");
  const original = "// rocky-managed\nexport default 1;\n";
  const installed = writeManagedPluginFile(path, original);
  assert.equal(installed.status, "written");
  assert.equal(installed.digest, createHash("sha256").update(original).digest("hex"));
  const modified = "// rocky-managed\nexport default 2;\n";
  writeFileSync(path, modified);
  assert.equal(removeManagedPluginFile(path, installed.digest).status, "changed");
  assert.equal(writeManagedPluginFile(path, original, installed.digest).status, "changed");
  assert.equal(writeManagedPluginFile(path, modified).status, "changed");
  assert.equal(readFileSync(path, "utf8"), modified);
  writeFileSync(path, original);
  assert.equal(removeManagedPluginFile(path, installed.digest).status, "removed");
  assert.equal(removeManagedPluginFile(path, installed.digest).status, "missing");
});

test("a plugin installed through a linked parent can be removed through the same path", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rocky-plugin-parent-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const realParent = join(dir, "plugins");
  const linkedParent = join(dir, "linked");
  mkdirSync(realParent);
  symlinkSync(realParent, linkedParent, process.platform === "win32" ? "junction" : "dir");
  const path = join(linkedParent, "hook.js");
  const content = "// rocky-managed\nexport default 1;\n";
  const installed = writeManagedPluginFile(path, content);
  assert.equal(installed.status, "written");
  assert.equal(readFileSync(join(realParent, "hook.js"), "utf8"), content);
  assert.equal(removeManagedPluginFile(path, installed.digest).status, "removed");
  assert.equal(lstatSync(linkedParent).isSymbolicLink(), true);
  assert.deepEqual(readdirSync(realParent), []);
});

test("plugin installation refuses a supplied parent retargeted during the write transaction", (t) => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "rocky-plugin-write-retarget-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = join(dir, "original");
  const replacement = join(dir, "replacement");
  const linked = join(dir, "linked");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  mkdirSync(original);
  mkdirSync(replacement);
  symlinkSync(original, linked, linkType);
  const path = join(linked, "hook.js");
  const installed = writeManagedPluginFile(path, "original content");
  assert.equal(installed.status, "written");
  writeFileSync(join(replacement, "hook.js"), "user content");
  const mkdir = fs.mkdirSync;
  let retargeted = false;
  fs.mkdirSync = ((target, options) => {
    const result = mkdir(target, options);
    if (basename(String(target)).startsWith(".hook.js.transaction-")) {
      fs.renameSync(linked, join(dir, "old-link"));
      symlinkSync(replacement, linked, linkType);
      retargeted = true;
    }
    return result;
  }) as typeof fs.mkdirSync;
  syncBuiltinESMExports();
  try {
    const result = writeManagedPluginFile(path, "updated content", installed.digest);
    assert.equal(retargeted, true);
    assert.equal(result.status, "recovery-required");
    assert.equal(readFileSync(join(original, "hook.js"), "utf8"), "original content");
    assert.equal(readFileSync(join(replacement, "hook.js"), "utf8"), "user content");
  } finally {
    fs.mkdirSync = mkdir;
    syncBuiltinESMExports();
  }
});

test("plugin removal restores the quarantined file if its supplied parent is retargeted", (t) => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "rocky-plugin-retarget-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = join(dir, "original");
  const replacement = join(dir, "replacement");
  const linked = join(dir, "linked");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  const name = "hook.js";
  mkdirSync(original);
  mkdirSync(replacement);
  symlinkSync(original, linked, linkType);
  const content = "// rocky-managed\nexport default 1;\n";
  const installed = writeManagedPluginFile(join(linked, name), content);
  assert.equal(installed.status, "written");
  const otherContent = "// rocky-managed\nexport default 2;\n";
  writeFileSync(join(replacement, name), otherContent);

  const rename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    rename(source, destination);
    if (source === join(original, name)) {
      rename(linked, join(dir, "old-link"));
      symlinkSync(replacement, linked, linkType);
    }
  };
  syncBuiltinESMExports();
  try {
    assert.equal(removeManagedPluginFile(join(linked, name), installed.digest).status, "changed");
    assert.equal(readFileSync(join(linked, name), "utf8"), otherContent);
    assert.equal(readFileSync(join(original, name), "utf8"), content);
    assert.deepEqual(readdirSync(original), [name]);
  } finally {
    fs.renameSync = rename;
    syncBuiltinESMExports();
  }
});

test("plugin removal refuses a file path with a trailing separator", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rocky-plugin-separator-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "hook.js");
  const content = "// rocky-managed\nexport default 1;\n";
  const installed = writeManagedPluginFile(path, content);
  assert.equal(installed.status, "written");
  for (const separator of ["/", "\\"]) {
    assert.equal(removeManagedPluginFile(path + separator, installed.digest).status, "changed");
    assert.equal(readFileSync(path, "utf8"), content);
  }
});

test("plugin removal preserves a replacement saved immediately before the file is moved", (t) => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "rocky-plugin-race-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "hook.js");
  const staged = join(dir, "editor-save");
  const previous = join(dir, "previous-hook");
  const installed = writeManagedPluginFile(path, "// rocky-managed\nexport default 1;\n");
  assert.equal(installed.status, "written");
  const modified = "// rocky-managed\nexport default 2;\n";
  writeFileSync(staged, modified);

  const rename = fs.renameSync;
  const unlink = fs.unlinkSync;
  let replaced = false;
  const replaceFile = (source: fs.PathLike): void => {
    if (source !== path || replaced) return;
    rename(path, previous);
    rename(staged, path);
    replaced = true;
  };
  fs.renameSync = (source, destination) => {
    replaceFile(source);
    rename(source, destination);
  };
  fs.unlinkSync = (source) => {
    replaceFile(source);
    unlink(source);
  };
  syncBuiltinESMExports();
  try {
    assert.equal(removeManagedPluginFile(path, installed.digest).status, "changed");
    assert.equal(replaced, true);
    assert.equal(readFileSync(path, "utf8"), modified);
    assert.deepEqual(readdirSync(dir).sort(), ["hook.js", "previous-hook"]);
  } finally {
    fs.renameSync = rename;
    fs.unlinkSync = unlink;
    syncBuiltinESMExports();
  }
});

test("a second plugin save keeps the first replacement recoverable without clobbering the live file", (t) => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "rocky-plugin-restore-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "hook.js");
  const installed = writeManagedPluginFile(path, "// rocky-managed\nexport default 1;\n");
  assert.equal(installed.status, "written");
  const firstSave = "// rocky-managed\nexport default 2;\n";
  const secondSave = "// rocky-managed\nexport default 3;\n";
  const rename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (source === path) writeFileSync(path, firstSave);
    rename(source, destination);
    if (source === path) writeFileSync(path, secondSave);
  };
  syncBuiltinESMExports();
  try {
    const result = removeManagedPluginFile(path, installed.digest);
    assert.equal(result.status, "changed");
    assert.ok(result.recoveryPath);
    assert.equal(readFileSync(result.recoveryPath, "utf8"), firstSave);
    assert.equal(readFileSync(path, "utf8"), secondSave);
  } finally {
    fs.renameSync = rename;
    syncBuiltinESMExports();
  }
});

test("Codex detects root inline hooks and ignores comments, multiline strings and unrelated tables", () => {
  assert.equal(detectCodexInlineHooksConflict("[[hooks.PostToolUse]]\nmatcher = '.+'"), true);
  assert.equal(detectCodexInlineHooksConflict(' [ "hooks" ] # retained'), true);
  assert.equal(detectCodexInlineHooksConflict("hooks = { PostToolUse = [] }"), true);
  assert.equal(detectCodexInlineHooksConflict(`# [hooks]
instructions = """
[[hooks.PostToolUse]]
"""
[mcp_servers.hooks]
hooks = {}
`), false);
  assert.equal(codexNotifySnippet(["rocky", "hook", "agent-event", "codex"]), 'notify = ["rocky", "hook", "agent-event", "codex"]');
});
