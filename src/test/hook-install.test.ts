import { test } from "node:test";
import assert from "node:assert/strict";
import { addHookBlock, hasHookBlock, removeHookBlock } from "../commands/hook.js";

const BLOCK_RE = /# >>> rocky hook >>>[\s\S]*# <<< rocky hook <<</;

test("addHookBlock appends managed block once", () => {
  const once = addHookBlock("# my bashrc\nalias ll='ls -l'\n");
  assert.match(once, BLOCK_RE);
  const twice = addHookBlock(once);
  assert.equal(twice, once, "idempotent");
  assert.equal(twice.match(/rocky hook >>>/g)?.length, 1);
});

test("removeHookBlock strips block and leaves rest intact", () => {
  const content = addHookBlock("# my bashrc\nalias ll='ls -l'\n");
  const removed = removeHookBlock(content);
  assert.ok(!hasHookBlock(removed));
  assert.ok(removed.includes("alias ll='ls -l'"));
  assert.equal(removeHookBlock(removed), removed, "idempotent on absent block");
});

test("removeHookBlock leaves content unchanged when END marker is missing", () => {
  // BEGIN present, END hand-deleted: nothing may be stripped, the bashrc tail survives
  const content = "# my bashrc\n# >>> rocky hook >>>\nalias ll='ls -l'\nexport EDITOR=vim\n";
  assert.equal(removeHookBlock(content), content, "truncated block: return content byte-for-byte");
});
