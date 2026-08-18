import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../core/package-info.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readmePage = readFileSync(join(packageRoot, "README.md"), "utf8");
// Detailed behavior contracts live in the linked reference so the front page can stay useful.
const reference = readFileSync(join(packageRoot, "docs", "reference.md"), "utf8");
const readme = `${readmePage}\n\n${reference}`;
const grounding = readFileSync(join(packageRoot, "docs", "scientific-grounding.md"), "utf8");
const modelSource = readFileSync(join(packageRoot, "src", "commands", "model.ts"), "utf8");
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

test("preservedKeys documentation names both check and watch ownership", () => {
  const comment = /\/\*\*[\s\S]*?\*\/\s*function preservedKeys/.exec(modelSource)?.[0];
  assert.ok(comment, "preservedKeys must keep its ownership comment");
  assert.match(comment, /`watch`/);
  assert.match(comment, /`check`/);
});

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

test("README and CLI help publish the installable command surface", () => {
  const help = helpOutput();
  const expected = [
    "npm install -g @poggufanz/rocky-cli",
    "rocky setup",
    "rocky check",
    "rocky mcp",
    "rocky recall --ai",
    "rocky what",
    "rocky how",
    "rocky why",
    "rocky digest",
    "rocky quiz",
    "rocky export",
    "rocky model",
    "rocky setup --voice-skill",
    "rocky setup --agent-hooks",
    "rocky setup --uninstall-agent-hooks",
    "rocky setup --status",
    "rocky watch",
  ] as const;

  assertContainsEvery(readmePage, "README", expected);
  assertContainsEvery(help, "CLI help", expected);

  for (const [label, surface] of [["README", readmePage], ["CLI help", help]] as const) {
    assert.equal(hasActiveUnscopedRockyInstall(surface), false, `${label} advertises unscoped Rocky install`);
    assert.doesNotMatch(surface, /never uploaded/i);
    assert.doesNotMatch(surface, /v0\.1[^\n]*(?:current|this release)/i);
    assertNoActiveExplain(surface, label);
  }
});

test("README stays a concise front page with durable project links", () => {
  assert.ok(readmePage.split("\n").length <= 180, "README detail belongs in docs/reference.md");
  assertContainsEvery(readmePage, "README project links", [
    "https://github.com/poggufanz/rocky/releases/tag/v0.6.0",
    "CHANGELOG.md",
    "LICENSE",
    "https://github.com/poggufanz/rocky/blob/main/SECURITY.md",
    "https://github.com/poggufanz/rocky/blob/main/CONTRIBUTING.md",
    "https://github.com/poggufanz/rocky/blob/main/docs/reference.md",
    "/assets/rocky-pixel.webp",
  ]);
});

test("README identity, roadmap, and Plan 01/Plan 02 v0.5 boundary stay aligned", () => {
  assert.ok(
    readmePage.includes(`${PACKAGE_NAME}@${PACKAGE_VERSION}`),
    "README package identity must come from the same name and version as package-info.ts",
  );

  const roadmap = readmePage.slice(readmePage.indexOf("## Roadmap"));
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
  assert.match(readme, /Nervous System \(v0\.5\.0\)/);
  assert.match(readme, /Plan 01[^\n]*implemented/i);
  assert.match(readme, /Plan 02[^\n]*(?:implemented|available|unreleased)/i);
  assert.match(readme, /user prompt|captured prompt/i);
  assert.match(readme, /edited paths?[^\n]*(?:excerpt|capped)/i);
  assert.match(readme, /stated rationale/i);
  assert.match(readme, /transient[^\n]*spool/i);
  assert.match(readme, /memory\.jsonl/);
  assert.match(readme, /0600|private/i);
  assert.match(readme, /no (?:new )?egress/i);
  assert.match(readme, /never (?:rewrite|inject|submit)[^\n]*prompt/i);
  assert.match(readme, /deterministic[^\n]*(?:fallback|degraded)/i);
  assert.match(readme, /loopback Ollama/i);
  assert.match(readme, /quoted[^\n]*untrusted hearsay/i);
  assertContainsEvery(readme, "README v0.5 dictionary surfaces", [
    'rocky what "move button down"',
    'rocky what --ai "move button down"',
    'rocky how "move button down"',
    "rocky why src/button.css",
    "rocky digest",
    "rocky quiz",
    "rocky export --kind triple > triples.jsonl",
    "rocky export --since 7d",
    "search_knowledge",
    "fetch_record",
    "why_file",
    "Reasons are hearsay Rocky heard, not verified facts.",
  ]);
  assert.match(readme, /filtered raw JSONL on stdout/i);
  assert.match(readme, /count\/persona line goes to stderr/i);
  assert.match(readme, /user-owned, append-only data/i);
  assert.match(readme, /at most one question for that turn/i);
  assert.match(readme, /detached, non-blocking ambiguity check/i);
  assert.match(readme, /never reads project files/i);
  assert.match(readme, /ignored questions are dropped and never repeated/i);
  assert.match(readme, /next shell prompt shows at most one label/i);
  assert.match(readme, /non-quiet `rocky watch` also shows it/i);
  assert.match(readme, /Labels never enter agent context/i);
  assert.match(readme, /`watch --quiet` stays plain-facts mode and does not poll persona labels/i);
  assert.match(readme, /Claude[^\n]*explicit consent/i);
  assert.match(readme, /pre-created[^\n]*\.claude/i);
  assert.match(readme, /Claude Code capture requires hook payload field `prompt_id`/i);
  assert.match(readme, /without `prompt_id`, Rocky records nothing and never merges turns/i);
  assert.match(readme, /manual[^\n]*Codex[^\n]*TOML/i);
  assert.match(readme, /\/hooks/);
  for (const mechanism of [
    "intent→mechanism dictionary",
    "reverse lookup",
    "ambiguity surfacing",
    "curious blind friend",
    "digest",
  ]) {
    const row = reference.split("\n").find((line) => line.trimStart().startsWith("|") && line.toLowerCase().includes(mechanism));
    assert.ok(row, `README must keep a conceptual row for ${mechanism}`);
    assert.match(row ?? "", /Plan 02 implemented/i, `${mechanism} must be marked implemented in Plan 02`);
  }
  const recallRow = reference.split("\n").find((line) => line.toLowerCase().includes("| recall |"));
  assert.ok(recallRow, "README must keep a conceptual row for current Recall");
  assert.match(recallRow ?? "", /Plan 01 implemented\/current/i);
  assert.doesNotMatch(recallRow ?? "", /Plan 02 deferred/i);
  for (const deferred of ["BYOK", "brief", "attest", "circuit breaker"]) {
    assert.match(readme, new RegExp(`${deferred}[^\\n]*defer|defer[^\\n]*${deferred}`, "i"));
  }
  const changelog = readFileSync(join(packageRoot, "CHANGELOG.md"), "utf8");
  assert.match(changelog, /## 0\.5\.0 — \d{1,2} \w+ \d{4}/);
});

test("README documents capability-gated Codex and staged Claude Code setup, not name-only live mutation", () => {
  assert.match(readme, /capability-gated/i, "README must describe Codex registration as capability-gated");
  assert.match(
    readme,
    /compare-and-swap|version-checked/i,
    "README must describe Codex's versioned/CAS write behavior",
  );
  assert.doesNotMatch(
    readme,
    /\bcodex mcp (?:add|remove)\b/i,
    "README must not describe Codex automation as a name-only `codex mcp add/remove`",
  );

  assert.match(
    readme,
    /private (?:copy|stage)/i,
    "README must describe Claude Code registration as staged into a private copy",
  );
  assert.match(
    readme,
    /polic(?:y|ies)[^\n]*(?:unchanged|equivalent)/i,
    "README must describe Claude Code policy-equivalence proof",
  );
  assert.match(
    readme,
    /recoverable transaction/i,
    "README must describe Claude Code publication as a recoverable transaction",
  );
  assert.doesNotMatch(
    readme,
    /\bclaude mcp (?:add|remove)\b/i,
    "README must not describe Claude Code automation as a live name-only `claude mcp add/remove`",
  );
  assert.doesNotMatch(
    readme,
    /remove-then-add|live config/i,
    "README must not describe the superseded remove-then-add rollback mechanism",
  );
});

test("README documents zero-eligible-host voice-skill behavior and Claude Desktop exclusion", () => {
  assert.ok(
    readme.includes("voice-skill: unavailable"),
    "README must contain the exact aggregate detail line `voice-skill: unavailable`",
  );
  assert.match(
    readme,
    /voice-skill: unavailable[^\n]*exit(?:s|ing)? 1|exit(?:s|ing)? 1[^\n]*voice-skill: unavailable/i,
    "README must pair `voice-skill: unavailable` with exit 1",
  );
  assert.match(
    readme,
    /prints `?voice-skill: unavailable`? and exits 1/i,
    "README must describe a single aggregate `voice-skill: unavailable` result, not an invented per-host result",
  );
  assert.match(
    readme,
    /Claude Desktop never receives the voice skill/i,
    "README must state Claude Desktop is never a voice-skill target",
  );
});

test("README status string for zero-eligible voice-skill matches the source literal exactly", () => {
  const setupSource = readFileSync(join(packageRoot, "src", "commands", "setup.ts"), "utf8");
  const match = /detail\("(voice-skill: [^"]+)"\)/.exec(setupSource);
  assert.ok(match, "expected src/commands/setup.ts to contain the voice-skill unavailable detail literal");
  assert.ok(
    readme.includes(match![1]),
    `README must contain the exact source literal ${JSON.stringify(match![1])}`,
  );
});

function isolatedCliRun(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  // Isolated HOME plus a PATH that resolves only `node` reproduces the default
  // first-run state for a Linux user with no Codex CLI, no Claude Code CLI, and
  // no Claude Desktop config - the exact scenario README's zero-eligible-host
  // voice-skill sentence describes.
  const root = mkdtempSync(join(tmpdir(), "rocky-doc-cli-"));
  try {
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const result = spawnSync(process.execPath, [join(packageRoot, "dist", "index.js"), ...args], {
      cwd: packageRoot,
      encoding: "utf8",
      env: {
        HOME: home,
        PATH: dirname(process.execPath),
        SHELL: "/bin/bash",
        ROCKY_HOME: join(home, ".rocky"),
      },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("compiled CLI honors the single zero-eligible-host voice-skill contract without --yes, matching README", async (t) => {
  // This is the end-to-end proof behind the prose assertions above: the
  // README claim holds against the real compiled CLI, not only against a
  // string grep, for the exact flagless invocations the whole-branch review
  // found diverging from the documented contract.
  const cases = [
    { name: "configure", argv: ["setup", "--voice-skill"] },
    { name: "remove", argv: ["setup", "--remove", "--voice-skill"] },
  ] as const;

  for (const entry of cases) {
    await t.test(entry.name, () => {
      const result = isolatedCliRun(entry.argv);
      assert.equal(result.status, 1, `stderr: ${result.stderr}`);
      assert.ok(
        result.stderr.split("\n").includes("voice-skill: unavailable"),
        `expected the exact "voice-skill: unavailable" line, got: ${result.stderr}`,
      );
    });
  }
});

test("README documents recoverable/conditional bashrc writes and corrupt-marker refusal", () => {
  assert.match(
    readme,
    /recoverable,? conditional transaction/i,
    "README must describe bashrc writes as a recoverable, conditional transaction",
  );
  assert.match(
    readme,
    /corrupt[^\n]*(?:marker|block)/i,
    "README must describe corrupt Rocky marker blocks",
  );
  assert.doesNotMatch(
    readme,
    /corrupt[^\n]*(?:is|are|remains?)\s+(?:installed|removed)\b/i,
    "README must not claim a corrupt hook block is installed or removed",
  );
  assert.match(
    readme,
    /exits? nonzero/i,
    "README must state hook status exits nonzero on corrupt/ambiguous state instead of claiming installed",
  );
});

test("README discloses the retained .bashrc recovery copy left by write attempts", () => {
  assert.match(
    readme,
    /\.bashrc`? already exists[^\n]*recovery copy[^\n]*previous bytes/i,
    "documentation must scope the previous-bytes recovery copy to an existing .bashrc",
  );
  assert.match(
    readme,
    /not under[^\n]*~\/\.rocky/i,
    "README must state the recovery copy lives outside ~/.rocky, directly in $HOME",
  );
  assert.match(
    readme,
    /full contents,? secrets included/i,
    "README must disclose the recovery copy holds the previous file's full contents, secrets included",
  );
  assert.match(
    readme,
    /your call/i,
    "README must state removing the recovery copy sooner is the user's call",
  );
  assert.match(
    readme,
    /completed transactions keep only the most recent completed copy/i,
    "documentation must scope pruning to completed transaction copies",
  );
  assert.match(
    readme,
    /pending or ambiguous recovery directories are retained and can accumulate/i,
    "documentation must disclose that unresolved recovery directories are not pruned",
  );
  assert.match(
    readme,
    /Claude Desktop uses the same conditional-transaction mechanism[^\n]*full timestamped sibling backup/i,
    "documentation must describe Claude Desktop's transaction and timestamped backup",
  );
  assert.match(
    readme,
    /timestamped backups are not automatically pruned/i,
    "documentation must disclose that Claude Desktop timestamped backups accumulate",
  );
  assert.match(
    readme,
    /Claude Code MCP automation is inactive[^\n]*normally makes no config write or backup/i,
    "documentation must state that shipped Claude Code automation normally leaves no backup",
  );
});

test("README discloses that hook status also settles and discloses a retained copy, not just install/uninstall", () => {
  // Round 5 pinned the claim "status never writes bashrc itself" here — the
  // whole-branch final audit found it false: with bashrc absent and a
  // restorable retained copy, settling recreates bashrc from that copy
  // (file-transaction.ts's restore-from-`displaced` path), and status
  // printed nothing about having done so. Corrected per the audit's
  // Important 1: status never edits the hook block itself, but settling can
  // create or restore bashrc from a retained copy, and both the README and
  // the command's own output must say so.
  assert.match(
    readme,
    /status[^\n]*never edits the hook block itself[^\n]*settl(?:e|ing)/i,
    "README must state status does not edit the hook block on its own, but does settle an interrupted transaction",
  );
  assert.match(
    readme,
    /settl(?:e|ing)[^\n]*can (?:create|restore) [^\n]*bashrc/i,
    "README must disclose that settling can create or restore bashrc from a retained copy",
  );
  assert.match(
    readme,
    /status[^\n]*(?:prints|says so and prints)[^\n]*(?:that|the) path/i,
    "README must state status discloses a retained copy it settles, matching install/uninstall's disclosure",
  );
  assert.doesNotMatch(
    readme,
    /status[^\n]*never writes bashrc itself/i,
    "README must not claim status never writes bashrc — settling can create or restore it",
  );
});

test("README discloses that a retained copy is never named for removal (round 7, F8)", () => {
  // Round 6's claim gated the no-removal guarantee on "(bashrc itself
  // missing)" — the exact defeated predicate the final audit's F1 broke: a
  // 0-byte bashrc Rocky itself left behind satisfies "bashrc exists" while
  // holding none of the user's content. The guarantee holds regardless of
  // whether bashrc happens to exist, so the README must not gate it on that
  // condition.
  assert.match(
    readme,
    /never (?:tells|instructs) you to remove a retained copy/i,
    "README must state Rocky never instructs removing a retained copy, unconditionally",
  );
  assert.doesNotMatch(
    readme,
    /bashrc itself missing/i,
    "README must not gate the no-removal guarantee on bashrc being absent — that predicate is defeated by a bashrc Rocky itself left broken",
  );
  assert.doesNotMatch(
    readme,
    /remove by hand/i,
    "README must not describe a removal-by-hand instruction anywhere in the bashrc recovery disclosure",
  );
});

test("README documents the Claude Code manual-fallback reality with the exact source literal", () => {
  const claudeCodeSource = readFileSync(join(packageRoot, "src", "setup", "claude-code.ts"), "utf8");
  const match = /MANUAL_CONFIGURE_DETAIL = "([^"]+)"/.exec(claudeCodeSource);
  assert.ok(match, "expected src/setup/claude-code.ts to contain MANUAL_CONFIGURE_DETAIL");
  assert.ok(
    readme.includes(match![1]),
    `README must contain the exact source literal ${JSON.stringify(match![1])}`,
  );
  assert.match(
    readme,
    /claude-code: failed[^\n]*exits? 1|exits? 1[^\n]*claude-code: failed/i,
    "README must pair `claude-code: failed` with exit 1",
  );
  assert.doesNotMatch(
    readme,
    /Claude Code[^\n]*(?:automation|registration)[^\n]*always (?:succeeds|works)/i,
    "README must not contradict the manual-fallback disclosure with a claim that Claude Code automation always succeeds",
  );
});

test("no shipped surface still claims the project makes no external network requests", () => {
  // v0.4 made `rocky check` call the npm registry. A blanket no-egress claim is
  // now false wherever it survives, and it survived in three places the first
  // pass missed — so every shipped documentation surface is checked here, not
  // just README, and the rejection is by claim SHAPE rather than by the one
  // exact sentence that happened to exist (rewording would have evaded that).
  const security = readFileSync(join(packageRoot, "SECURITY.md"), "utf8");
  const surfaces = [
    ["README", readme],
    ["SECURITY.md", security],
    ["scientific-grounding.md", grounding],
    ["CLI help", helpOutput()],
  ] as const;

  const blanketClaims = [
    /\bcore CLI[^.\n]*\bno (?:telemetry or )?external (?:network )?(?:egress|requests)/i,
    /\bCLI and (?:the )?(?:local )?MCP server[^.\n]*\bmakes? no external network requests/i,
    /\bthe project\b[^.\n]*\bmakes? no external (?:network )?requests/i,
    /\bRocky\b[^.\n]*\bmakes? no external network requests\b(?![^.\n]*(?:except|other than|apart from))/i,
  ] as const;

  for (const [label, surface] of surfaces) {
    for (const claim of blanketClaims) {
      assert.doesNotMatch(surface, claim, `${label} still carries a blanket no-external-egress claim`);
    }
  }

  // And the two surfaces that describe the network contract in prose must name
  // the one thing that does leave the machine.
  for (const [label, surface] of [["README", readme], ["SECURITY.md", security]] as const) {
    assert.ok(surface.includes("registry.npmjs.org"), `${label} must name the one external host Rocky contacts`);
  }
});

test("README keeps the sanitized-default, raw-opt-in, and loopback-only network contract", () => {
  assert.match(readme, /contains no telemetry/i, "README must state the CLI contains no telemetry");
  assert.match(readme, /runs no daemon/i, "README must state Rocky runs no daemon");
  // v0.4 turned the old blanket "no external network requests" claim false:
  // `rocky check` really does call the registry. The claim is now scoped, and
  // the scoping is pinned here so it cannot silently widen back out.
  assert.match(
    readme,
    /only external network egress is `rocky check`/i,
    "README must scope external egress to rocky check's registry lookup",
  );
  // The qualifiers must live in the SAME paragraph as the egress claim.
  // Scattered across the document they would pass a bare `includes` while
  // leaving the sentence a reader actually sees unqualified.
  const egressParagraph = readme
    .split("\n\n")
    .find((paragraph) => /only external network egress is `rocky check`/i.test(paragraph));
  assert.ok(egressParagraph, "README must contain the scoped egress paragraph");
  for (const [term, label] of [
    ["registry.npmjs.org", "name the registry host"],
    ["package names only", "state only package names leave the machine"],
    ["consent-gated", "describe the consent gate"],
    ["fail-open when offline", "state the lookup fails open"],
  ] as const) {
    assert.ok(
      egressParagraph!.toLowerCase().includes(term.toLowerCase()),
      `README's egress paragraph must ${label}`,
    );
  }
  assert.match(
    readme,
    /sanitized memory by default|sanitized[^\n]*by default/i,
    "README must state sanitized memory is the default MCP exposure",
  );
  assert.match(
    readme,
    /raw exposure only when you intend/i,
    "README must describe raw exposure as an explicit opt-in",
  );
  assert.ok(readme.includes("127.0.0.1"), "README must name the loopback address for optional AI");
});

test("README documents the native Windows command boundary and bounded loopback AI contract", () => {
  assert.match(readme, /8,191 characters/);
  assert.match(readme, /7,111-character command/);
  assert.match(readme, /9,111-character command/);
  assert.match(readme, /response file, configuration file, or script/);
  assert.match(readme, /does not silently rewrite the command/);
  assert.match(readme, /64 KiB.*256 KiB.*20 seconds/);
  assert.match(readme, /30-second deadline.*discovery.*probe/);
});

function topLevelCommandSurface(indexSource: string): Set<string> {
  // Scrape only the outer `switch (command)` in main() - not the nested `hook`
  // sub-switch (install/uninstall/status are never dispatched as `rocky <word>`,
  // only as `rocky hook <word>`) and not the internal `_hookfail`/`_hooksuccess`
  // markers, which are dispatch targets but never advertised commands. Without
  // this scoping, a help line that wrongly names any of those (e.g. `rocky
  // status`) would pass vacuously because the bare word is a known `case` label
  // somewhere in the file, just not one reachable via `rocky <word>`.
  const outerStart = indexSource.indexOf("switch (command) {");
  assert.ok(outerStart >= 0, "expected src/index.ts to contain the top-level command switch");
  const nestedStart = indexSource.indexOf("switch (rest[0])", outerStart);
  assert.ok(nestedStart >= 0, "expected src/index.ts to contain the nested hook switch");
  const nestedBraceOpen = indexSource.indexOf("{", nestedStart);
  assert.ok(nestedBraceOpen >= 0, "expected the nested hook switch to open a block");
  let depth = 0;
  let nestedEnd = -1;
  for (let i = nestedBraceOpen; i < indexSource.length; i += 1) {
    if (indexSource[i] === "{") depth += 1;
    else if (indexSource[i] === "}") {
      depth -= 1;
      if (depth === 0) { nestedEnd = i; break; }
    }
  }
  assert.ok(nestedEnd >= 0, "expected the nested hook switch block to close");
  const withoutNestedSwitch = indexSource.slice(0, nestedStart) + indexSource.slice(nestedEnd + 1);

  const commands = new Set<string>();
  for (const match of withoutNestedSwitch.matchAll(/case\s+"([a-zA-Z_-]+)":/g)) {
    if (match[1].startsWith("_")) continue;
    commands.add(match[1]);
  }
  return commands;
}

test("CLI help does not advertise a command that does not exist", () => {
  const help = helpOutput();
  const indexSource = readFileSync(join(packageRoot, "src", "index.ts"), "utf8");
  const knownCommands = topLevelCommandSurface(indexSource);
  assert.ok(knownCommands.has("hook"), "sanity: top-level command scrape must still find `hook`");
  assert.ok(!knownCommands.has("status"), "sanity: nested hook sub-switch labels must not leak into the top-level surface");
  assert.ok(!knownCommands.has("_hookfail"), "sanity: internal dispatch markers must not leak into the top-level surface");

  for (const line of help.split("\n")) {
    const commandMatch = /^\s*rocky\s+([a-zA-Z-]+)\b/.exec(line);
    if (commandMatch === null) continue;
    assert.ok(
      knownCommands.has(commandMatch[1]),
      `help advertises "rocky ${commandMatch[1]}", which has no matching top-level case in src/index.ts main(): ${line}`,
    );
  }
});

test("README and CLI help avoid forbidden universal-support and evidence overclaims", () => {
  const help = helpOutput();
  for (const [label, surface] of [["README", readme], ["CLI help", help]] as const) {
    assert.doesNotMatch(surface, /\buniversal\b[^\n]*(?:host|platform)/i, `${label} claims universal host/platform support`);
    assert.doesNotMatch(surface, /\bevery (?:host|platform)\b/i, `${label} claims every host/platform is supported`);
    assert.doesNotMatch(
      surface,
      /\b(?:CI|release candidate|hosted)[^\n]*(?:passed|verified|certified)\b/i,
      `${label} claims post-fix CI/host/release evidence passed`,
    );
    assert.doesNotMatch(
      surface,
      /automatic(?:ally)?[^\n]*(?:install|installs|installed|installing)[^\n]*(?:model|skill|hook)/i,
      `${label} claims automatic model/skill/hook installation`,
    );
  }
});

test("README states zero runtime/optional dependencies, reusing package metadata as source of truth", () => {
  assert.match(readmePage, /zero runtime dep/i, "README must state zero runtime dependencies");
});

test("documentation names one canonical source and package root", () => {
  assert.match(readmePage, /fresh clone[\s\S]*package root/i);
  assert.match(readmePage, /outer workspace[\s\S]*rocky\//i);
  assert.match(readmePage, /canonical (?:developer )?(?:line|branch)[\s\S]*main/i);
  assert.doesNotMatch(readmePage, /published package version is/i);
});

test("scientific grounding keeps v0.5 learning mechanisms bounded and evidence claims honest", () => {
  assert.match(grounding, /v0\.5 dictionary connects a user's recorded intent to the mechanism/i);
  assert.match(grounding, /asking and follow-up behavior is implemented in the 0\.5 release line/i);
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
