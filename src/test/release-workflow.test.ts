import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Compiled tests run from <root>/.test-dist/test, two levels below the package root.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowsDir = join(repoRoot, ".github", "workflows");

function workflowFiles(): Array<{ name: string; text: string }> {
  return readdirSync(workflowsDir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(workflowsDir, name), "utf8") }));
}

function releaseWorkflow(): string {
  return readFileSync(join(workflowsDir, "release.yml"), "utf8");
}

// One job block: from its two-space key to the next two-space key or the end.
function jobBlock(workflow: string, job: string): string {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === `  ${job}:`);
  assert.notEqual(start, -1, `release.yml has no ${job} job`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/u.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

test("release workflow: only the publish job asks for id-token write", () => {
  const holders = workflowFiles().flatMap((file) =>
    file.text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line === "id-token: write")
      .map(() => file.name),
  );
  assert.deepEqual(holders, ["release.yml"], "id-token: write must appear exactly once, in release.yml");
  const publish = jobBlock(releaseWorkflow(), "publish");
  assert.equal(
    publish.split("\n").filter((line) => line.trim() === "id-token: write").length,
    1,
    "the publish job must be the holder of id-token: write",
  );
});

test("release workflow: publish runs only for pushed v tags", () => {
  const publish = jobBlock(releaseWorkflow(), "publish");
  const publishIf = publish.split("\n").find((line) => /^ {4}if:/u.test(line));
  assert.ok(publishIf !== undefined, "publish job has no if:");
  assert.ok(publishIf.includes("github.event_name == 'push'"), publishIf);
  assert.ok(publishIf.includes("startsWith(github.ref, 'refs/tags/v')"), publishIf);
});

test("release workflow: platforms publish before the main package and pins are checked", () => {
  const lines = jobBlock(releaseWorkflow(), "publish").split("\n");
  // A step command is the whole `- run:` line (or a bare line inside a script),
  // so a command only matches itself, never a longer command with the same prefix.
  const indexOfCommand = (command: string): number =>
    lines.findIndex((line) => line.trim().replace(/^- run: /u, "") === command);
  const order = [
    "npm publish ./platform/win32-x64 --ignore-scripts",
    "npm publish ./platform/linux-x64 --ignore-scripts",
    "node scripts/platform-packages.mjs inject package.json",
    "node scripts/platform-packages.mjs check package.json",
    "npm publish --ignore-scripts",
  ];
  const indexes = order.map(indexOfCommand);
  indexes.forEach((index, position) => {
    assert.notEqual(index, -1, `publish job never runs: ${order[position]}`);
    if (position > 0) {
      assert.ok(indexes[position - 1] < index, `${order[position - 1]} must run before ${order[position]}`);
    }
  });
});

test("release workflow: verify needs a green CI run and matching versions", () => {
  const workflow = releaseWorkflow();
  assert.ok(workflow.includes("actions/workflows/ci.yml/runs?head_sha="), "verify queries CI runs by head sha");
  assert.ok(workflow.includes("status=success"), "verify counts only successful CI runs");
  assert.ok(workflow.includes("refs/tags/v"), "verify only releases from a v tag");
});

test("release workflow: no npm token secret", () => {
  for (const file of workflowFiles()) {
    assert.ok(!file.text.includes("NPM_TOKEN"), `${file.name} mentions NPM_TOKEN`);
    assert.ok(!file.text.includes("NODE_AUTH_TOKEN"), `${file.name} mentions NODE_AUTH_TOKEN`);
  }
});
