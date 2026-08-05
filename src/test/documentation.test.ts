import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../core/package-info.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readme = readFileSync(join(packageRoot, "README.md"), "utf8");
const grounding = readFileSync(join(packageRoot, "docs", "scientific-grounding.md"), "utf8");
const unscopedRockyInstall = /\bnpm\s+(?:install|i)(?=\s)[^\n;&|#]*?[\s`'"]rocky-cli(?:@[^\s`'",;:)]+)?(?=$|[\s`'",;:.)])/i;
const inactiveInstallContext = /\b(?:historical|superseded|negative test|not an active command)\b|\b(?:do not|don't|never) use\b/i;

function helpOutput(): string {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [join(packageRoot, "dist", "index.js"), "--help"], {
    cwd: packageRoot,
    encoding: "utf8",
    env,
  });
  assert.equal(result.status, 0, result.stderr);
  return `${result.stdout}${result.stderr}`;
}

function assertContainsEvery(surface: string, label: string, expected: readonly string[]): void {
  for (const value of expected) {
    assert.ok(surface.includes(value), `${label} must include ${JSON.stringify(value)}`);
  }
}

function assertNoActiveExplain(surface: string, label: string): void {
  for (const line of surface.split("\n").filter((candidate) => candidate.includes("rocky explain"))) {
    assert.match(line, /superseded|not an active command/i, `${label} advertises rocky explain: ${line}`);
  }
}

function hasActiveUnscopedRockyInstall(surface: string): boolean {
  return surface.split("\n").some((line) => (
    unscopedRockyInstall.test(line) && !inactiveInstallContext.test(line)
  ));
}

test("unscoped Rocky install matcher rejects active commands only", () => {
  const cases = [
    ["npm install -g rocky-cli", true],
    ["npm i -g rocky-cli", true],
    ["npm install rocky-cli", true],
    ["npm i rocky-cli", true],
    ["npm install --save-dev other-package rocky-cli@0.2.0", true],
    ["Use `npm i other-package rocky-cli --save-exact`.", true],
    ["npm install -g @poggufanz/rocky-cli", false],
    ["npm install @poggufanz/rocky-cli", false],
    ["npm install @poggufanz/rocky-cli@0.2.1-beta.0", false],
    ["npm install rocky-cli-helper", false],
    ["Historical example: npm install rocky-cli@0.1.0", false],
    ["Negative test: do not use npm i --save-dev rocky-cli", false],
  ] as const;

  for (const [surface, expected] of cases) {
    assert.equal(hasActiveUnscopedRockyInstall(surface), expected, surface);
  }
});

test("README and CLI help publish the installable v0.2.1 command surface", () => {
  const help = helpOutput();
  const expected = [
    "npm install -g @poggufanz/rocky-cli",
    "rocky setup",
    "rocky mcp",
    "rocky recall --ai",
    "rocky model",
    "rocky setup --voice-skill",
  ] as const;

  assertContainsEvery(readme, "README", expected);
  assertContainsEvery(help, "CLI help", expected);

  for (const [label, surface] of [["README", readme], ["CLI help", help]] as const) {
    assert.equal(hasActiveUnscopedRockyInstall(surface), false, `${label} advertises unscoped Rocky install`);
    assert.doesNotMatch(surface, /never uploaded/i);
    assert.doesNotMatch(surface, /v0\.1[^\n]*(?:current|this release)/i);
    assertNoActiveExplain(surface, label);
  }
});

test("README identity, roadmap, and v0.5 hypothesis stay aligned with shipped metadata", () => {
  assert.ok(
    readme.includes(`${PACKAGE_NAME}@${PACKAGE_VERSION}`),
    "README package identity must come from the same name and version as package-info.ts",
  );

  const roadmap = readme.slice(readme.indexOf("## Roadmap"));
  const releaseOrder = ["v0.2.1", "v0.3", "v0.4", "v0.5"] as const;
  let previous = -1;
  for (const release of releaseOrder) {
    const current = roadmap.indexOf(release);
    assert.ok(current > previous, `${release} must follow the preceding roadmap release`);
    previous = current;
  }

  assert.match(readme, /\*\*The Good Trade\.\*\*/);
  assert.ok(readme.includes("This is Rocky's v0.5 product hypothesis, not an established outcome."));
  assert.match(readme, /more effective/i);
  assert.match(readme, /does not mean (?:the )?model weights change/i);
  assert.ok(readme.includes(
    "v0.2.1 does not implement the v0.5 nervous-system hooks, bidirectional intent↔mechanism lookup, ambiguity handling, proactive questions, digest, quiz, or BYOK annotation.",
  ));
});

test("scientific grounding keeps v0.5 learning mechanisms planned and evidence claims bounded", () => {
  assert.match(grounding, /planned v0\.5 dictionary is designed to help close the comprehension loop/i);
  assert.match(grounding, /asking and follow-up behavior[^\n]*planned v0\.5/i);
  assert.match(grounding, /consistent with/i);
  assert.ok(grounding.includes("https://pubmed.ncbi.nlm.nih.gov/25886768/"));
  assert.ok(grounding.includes("https://pmc.ncbi.nlm.nih.gov/articles/PMC7651899/"));
  assert.doesNotMatch(grounding, /closes the comprehension loop/i);
  assert.doesNotMatch(grounding, /Rocky, probably/i);
  assert.doesNotMatch(grounding, /rocky remember/i);
  assert.ok(grounding.includes("You teach, I remember. I remind, you understand. This is good trade."));
  assert.ok(grounding.includes(
    "Original Rocky project tagline; not a quotation from Project Hail Mary",
  ));
});
