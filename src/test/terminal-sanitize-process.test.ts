import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint } from "../core/fingerprint.js";

const packageRoot = process.cwd();
const cli = join(packageRoot, "dist", "index.js");
const activeTerminalControl = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const hostile = "safe 🪨 工程 e\u0301\u001b[2J\u001b]8;;https://fixture.invalid\u0007link\u001b]8;;\u001b\\\u001b]52;c;Zml4dHVyZQ==\u0007\u001bPpayload\u001b\\\u001b_apc\u001b\\\u0007\b\r\u202eover\u202c\u2066iso\u2069";

function assertTerminalSafe(value: string): void {
  assert.doesNotMatch(value, activeTerminalControl);
  assert.doesNotMatch(value, /\u001b/u);
}

test("recall sanitizes stored command, excerpt, fix, and cwd while raw JSONL remains raw", (t) => {
  const home = mkdtempSync(join(tmpdir(), "rocky-terminal-recall-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const storedCmd = `fixture "line\n\t${hostile}"`;
  const failure = {
    kind: "failure", id: "failure-1", ts: Date.now() - 1_000, cwd: `cwd-${hostile}`,
    cmd: storedCmd, exitCode: 67, fingerprint: "fixture-fp", signature: ["needle"],
    excerpt: `first\n[Rocky] forged\t${hostile}\nthird`, resolvedBy: "fix-1",
  };
  const fix = {
    kind: "fix", id: "fix-1", ts: Date.now(), cwd: `fix-cwd-${hostile}`,
    cmd: storedCmd, failureIds: ["failure-1"], links: [{ id: "failure-1", basis: "signature" }],
  };
  const memoryPath = join(home, "memory.jsonl");
  writeFileSync(memoryPath, `${JSON.stringify(failure)}\n${JSON.stringify(fix)}\n`, "utf8");

  const result = spawnSync(process.execPath, [cli, "recall", "needle"], {
    env: { ...process.env, ROCKY_HOME: home, NO_COLOR: "1" }, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assertTerminalSafe(result.stderr);
  assert.match(result.stderr, /fixture "line\\n\\t/);
  assert.match(result.stderr, /safe 🪨 工程 e\u0301/u);
  assert.match(result.stderr, /\[remembered Rocky\] forged/u);
  assert.doesNotMatch(result.stderr, /\[Rocky\] forged/u);
  assert.match(readFileSync(memoryPath, "utf8"), /\\u001b\[2J/);
});

test("repeated run sanitizes remembered fix and alternate cwd without changing live stderr", (t) => {
  const home = mkdtempSync(join(tmpdir(), "rocky-terminal-run-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cmd = `${JSON.stringify(process.execPath)} -e "process.stderr.write('synthetic-terminal-failure\\n');process.exit(67)"`;
  const failure = {
    kind: "failure", id: "failure-1", ts: Date.now() - 1_000, cwd: process.cwd(), cmd: `repair "line\n\t${hostile}"`,
    exitCode: 67, fingerprint: fingerprint("synthetic-terminal-failure", cmd, 67),
    signature: ["synthetic-terminal-failure"], excerpt: "synthetic-terminal-failure", resolvedBy: "fix-1",
  };
  const fix = {
    kind: "fix", id: "fix-1", ts: Date.now(), cwd: `elsewhere-${hostile}`,
    cmd: failure.cmd, failureIds: ["failure-1"], links: [{ id: "failure-1", basis: "signature" }],
  };
  writeFileSync(join(home, "memory.jsonl"), `${JSON.stringify(failure)}\n${JSON.stringify(fix)}\n`, "utf8");

  const result = spawnSync(process.execPath, [cli, "run", cmd], {
    env: { ...process.env, ROCKY_HOME: home, NO_COLOR: "1" }, encoding: "utf8",
  });
  assert.equal(result.status, 67, result.stderr);
  assert.match(result.stderr, /^synthetic-terminal-failure/m);
  assert.match(result.stderr, /repair "line\\n\\t/);
  assertTerminalSafe(result.stderr);
});

test("Rocky color remains owned by TTY policy and NO_COLOR", () => {
  const redirectedScript = "Object.defineProperty(process.stdout,'isTTY',{value:true}); import('./dist/ui/rocky.js').then(m=>m.say('fixture'))";
  const redirected = spawnSync(process.execPath, ["--input-type=module", "-e", redirectedScript], {
    cwd: packageRoot, encoding: "utf8",
  });
  assert.doesNotMatch(redirected.stderr, /\u001b/u, "redirected stderr must stay clean even when stdout is a TTY");

  const ttyScript = "Object.defineProperty(process.stderr,'isTTY',{value:true}); import('./dist/ui/rocky.js').then(m=>m.say('fixture'))";
  const tty = spawnSync(process.execPath, ["--input-type=module", "-e", ttyScript], { cwd: packageRoot, encoding: "utf8" });
  assert.match(tty.stderr, /\u001b\[33m\[Rocky\]\u001b\[0m/);
  const noColor = spawnSync(process.execPath, ["--input-type=module", "-e", ttyScript], {
    cwd: packageRoot, env: { ...process.env, NO_COLOR: "1" }, encoding: "utf8",
  });
  assert.doesNotMatch(noColor.stderr, /\u001b/u);
  const nonTty = spawnSync(process.execPath, ["--input-type=module", "-e", "import('./dist/ui/rocky.js').then(m=>m.say('fixture'))"], {
    cwd: packageRoot, encoding: "utf8",
  });
  assert.doesNotMatch(nonTty.stderr, /\u001b/u);

  const stdoutTtyFace = spawnSync(process.execPath, ["--input-type=module", "-e",
    "Object.defineProperty(process.stdout,'isTTY',{value:true}); import('./dist/ui/rocky.js').then(m=>process.stdout.write(m.face()))"],
  { cwd: packageRoot, encoding: "utf8" });
  assert.match(stdoutTtyFace.stdout, /\u001b\[33m/u, "stdout-owned face keeps color on TTY stdout");
  const redirectedFace = spawnSync(process.execPath, ["--input-type=module", "-e",
    "Object.defineProperty(process.stderr,'isTTY',{value:true}); import('./dist/ui/rocky.js').then(m=>process.stdout.write(m.face()))"],
  { cwd: packageRoot, encoding: "utf8" });
  assert.doesNotMatch(redirectedFace.stdout, /\u001b/u, "redirected stdout stays clean even when stderr is a TTY");
});

test("live child stderr bytes are preserved byte-for-byte as a contiguous prefix", () => {
  const childBytes = Buffer.from([0x66, 0x69, 0x78, 0x00, 0x07, 0x08, 0x0d, 0x1b, 0x5b, 0x32, 0x4a, 0x0a]);
  const encoded = childBytes.toString("base64");
  const cmd = `${JSON.stringify(process.execPath)} -e "process.stderr.write(Buffer.from('${encoded}','base64'));process.exit(67)"`;
  const home = mkdtempSync(join(tmpdir(), "rocky-terminal-live-"));
  try {
    const result = spawnSync(process.execPath, [cli, "run", cmd], {
      env: { ...process.env, ROCKY_HOME: home, NO_COLOR: "1" }, encoding: null,
    });
    assert.equal(result.status, 67);
    assert.deepEqual(result.stderr.subarray(0, childBytes.length), childBytes);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
