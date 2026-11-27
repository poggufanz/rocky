import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
