import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { commandFingerprint } from "../core/fingerprint.js";
import { speakFailureMemory } from "../commands/run.js";

const packageRoot = process.cwd();
const cli = join(packageRoot, "dist", "index.js");

test("run speech discloses cross-directory fix as possible, never strong", () => {
  const failureCwd = join(tmpdir(), "rocky-run-failure");
  const fixCwd = join(tmpdir(), "rocky-run-fix");
  const cmd = "node stable-command.js";
  const failure = {
    kind: "failure" as const, id: "run-cross-failure", ts: Date.now() - 1_000, cwd: failureCwd, cmd,
    exitCode: 1, fingerprint: "run-cross-fingerprint", signature: ["failure"], excerpt: "failure",
    commandIdentity: JSON.stringify(["node", "stable-command.js"]), identityV: 1 as const,
    identityReliable: true, platform: process.platform,
  };
  const fix = {
    kind: "fix" as const, id: "run-cross-fix", ts: Date.now(), cwd: fixCwd, cmd,
    failureIds: [failure.id], links: [{ id: failure.id, basis: "identity" as const, confidence: "confirmed" as const }],
  };
  const original = process.stderr.write;
  let output = "";
  process.stderr.write = ((chunk: string | Uint8Array) => { output += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    speakFailureMemory([failure, fix], failure.fingerprint, 1, failureCwd);
  } finally {
    process.stderr.write = original;
  }
  assert.match(output, /place:/);
  assert.match(output, /possible only|maybe not fix/);
  assert.doesNotMatch(output, /strong\./);
  assert.match(output, new RegExp(fixCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(commandFingerprint(cmd, 1).length > 0, true);
});

test("unrelated successful npm task is not suggested as confirmed fix", (t) => {
  const home = mkdtempSync(join(tmpdir(), "rocky-causal-fix-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, ROCKY_HOME: home };
  const project = join(home, "synthetic-project");
  mkdirSync(project);
  writeFileSync(join(project, "package.json"), JSON.stringify({
    private: true,
    scripts: {
      "broken-alpha": "node -e \"process.stderr.write('synthetic causal failure\\\\n');process.exit(67)\"",
      "unrelated-beta": "node -e \"process.exit(0)\"",
    },
  }), "utf8");

  const first = spawnSync(process.execPath, [cli, "run", "npm run broken-alpha"], { cwd: project, env, encoding: "utf8" });
  assert.equal(first.status, 67);
  const success = spawnSync(process.execPath, [cli, "run", "npm run unrelated-beta"], { cwd: project, env, encoding: "utf8" });
  assert.equal(success.status, 0);
  const second = spawnSync(process.execPath, [cli, "run", "npm run broken-alpha"], { cwd: project, env, encoding: "utf8" });
  assert.equal(second.status, 67);
  assert.doesNotMatch(second.stderr, /last time, you fix with:/);
  assert.doesNotMatch(second.stderr, /unrelated-beta/);

  const lines = readFileSync(join(home, "memory.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.some((record) => record.kind === "fix"), false);
  const association = lines.find((record) => record.kind === "association");
  assert.deepEqual(association.candidateFailureIds.length, 1);
  assert.equal(existsSync(join(home, "pending")), true, "possible association must not clear pending");

  const stats = spawnSync(process.execPath, [cli, "stats"], { cwd: project, env, encoding: "utf8" });
  assert.equal(stats.status, 0);
  assert.match(stats.stderr, /0 fix events/);
});
