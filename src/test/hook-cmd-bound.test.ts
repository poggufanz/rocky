import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordFailure, recordHookFailure } from "../core/memory.js";
import { commandFingerprint, normalizeLine } from "../core/fingerprint.js";

/** Run `fn` with ROCKY_HOME pointed at a fresh sandbox; restore afterward. */
function withSandboxHome<T>(fn: () => T): T {
  const home = mkdtempSync(join(tmpdir(), "rocky-cmd-bound-"));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

/** A shell-integration bootstrap shaped like the Orca OSC 133 blob: kilobytes of comments, real command last. */
function giantBootstrap(): string {
  const head = "# Orca OSC 133 shell integration for PowerShell. # Profiles have already loaded.\n";
  const filler = `# filler line to inflate the bootstrap blob past any sane bound\n`;
  const tail = `claude '--dangerously-skip-permissions' '--resume' '57e043df-1598-423a-bf39-a0edeae5a010'`;
  return head + filler.repeat(600) + tail;
}

test("recordHookFailure bounds a giant bootstrap cmd head+tail", () => {
  withSandboxHome(() => {
    const cmd = giantBootstrap();
    assert.ok(Buffer.byteLength(cmd, "utf8") > 20000, "fixture must be giant");
    const rec = recordHookFailure(cmd, 1, "C:\\work\\repo");
    assert.ok(Buffer.byteLength(rec.cmd, "utf8") <= 1200, `stored cmd must fit 1200 bytes, got ${Buffer.byteLength(rec.cmd, "utf8")}`);
    assert.match(rec.cmd, /…/, "bounded cmd carries the truncation marker");
    assert.doesNotMatch(rec.cmd, /\n/, "bounded cmd is flattened to one line");
    assert.match(rec.cmd, /Orca OSC 133/, "head survives bounding");
    assert.match(rec.cmd, /57e043df-1598-423a-bf39-a0edeae5a010/, "tail survives bounding");
    assert.equal(rec.excerpt, "exit 1");
  });
});

test("recordHookFailure leaves a short cmd byte-identical", () => {
  withSandboxHome(() => {
    const rec = recordHookFailure("npm test", 1, "C:\\work\\repo");
    assert.equal(rec.cmd, "npm test");
  });
});

test("recordHookFailure derives fingerprint and signature from the stored cmd", () => {
  withSandboxHome(() => {
    const rec = recordHookFailure(giantBootstrap(), 1, "C:\\work\\repo");
    assert.equal(rec.fingerprint, commandFingerprint(rec.cmd, 1));
    assert.deepEqual(rec.signature, [normalizeLine(rec.cmd)]);
    const again = recordHookFailure(giantBootstrap(), 1, "C:\\work\\repo");
    assert.equal(again.fingerprint, rec.fingerprint, "same giant cmd fingerprints deterministically");
  });
});

test("recordFailure bounds a giant cmd too", () => {
  withSandboxHome(() => {
    const rec = recordFailure(giantBootstrap(), 1, "boom");
    assert.ok(Buffer.byteLength(rec.cmd, "utf8") <= 1200);
    assert.match(rec.cmd, /…/);
  });
});
