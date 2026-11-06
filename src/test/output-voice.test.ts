import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { phrase, phraseForAct, phraseKeys, validateOutputLine } from "../ui/phrases.js";
import { OUTPUT_PREFIX, prompt } from "../ui/rocky.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("output validator flags each retired voice marker", () => {
  assert.deepEqual(validateOutputLine("[Rocky] memory works"), ["old-prefix"]);
  assert.deepEqual(validateOutputLine("check evidence, question"), ["question-suffix"]);
  assert.deepEqual(validateOutputLine("command passes now, good good good"), ["repetition"]);
  assert.deepEqual(validateOutputLine("command dies. bad."), ["verdict-tag"]);
  assert.deepEqual(validateOutputLine("you fix, I remember"), ["first-person"]);
  assert.deepEqual(validateOutputLine("rocky binary gone. my hook stops."), ["first-person"]);
  assert.deepEqual(validateOutputLine("rocky hears the failure"), ["lore"]);
  assert.deepEqual(validateOutputLine("the hook's ears sleep now"), ["lore"]);
  assert.deepEqual(validateOutputLine("memory works 👀"), ["emoji"]);
});

test("output validator accepts plain sentences, questions, and articles", () => {
  for (const value of [
    "New error recorded (exit code 1).",
    "Same error as before. No fix recorded yet.",
    "Command passes now; linked to the earlier failure. The change itself was not recorded.",
    "checked net change: 4 new text lines, 2 files. no secret hit.",
    "Allow registry lookup? [y/N]",
    "Your answer:",
    "Run rocky setup --remove --yes to remove it.",
  ]) {
    assert.deepEqual(validateOutputLine(value), [], value);
  }
});

test("output validator does not flag words that only contain a marker", () => {
  assert.deepEqual(validateOutputLine("Readme and mypy and mine-field stay plain."), []);
  assert.deepEqual(validateOutputLine("goodness and badge are not verdicts."), []);
  assert.deepEqual(validateOutputLine("Disk I/O stalled for 3 seconds."), []);
});

test("every catalog phrase follows the output rules", () => {
  for (const key of phraseKeys) assert.deepEqual(validateOutputLine(phrase(key)), [], key);
});

test("say and prompt share one lowercase prefix", () => {
  assert.equal(OUTPUT_PREFIX, "rocky:");
  assert.equal(prompt(phrase("check-answer")), "rocky: Your answer: ");
  assert.match(prompt(phrase("check-registry-consent")), /^rocky: .*Allow registry lookup\? \[y\/N\] $/);
});

test("link and recurrence lines state what was recorded and never claim a fix", () => {
  assert.equal(
    phrase("fix-linked"),
    "Command passes now; linked to the earlier failure. The change itself was not recorded.",
  );
  assert.equal(
    phrase("fix-recurrence-same"),
    "Last time, the same command passed again afterward. The change itself was not recorded.",
  );
  for (const key of ["fix-linked", "fix-recurrence-same"] as const) {
    assert.ok(phraseKeys.includes(key), `${key} must be registered so the catalog lint covers it`);
    assert.doesNotMatch(phrase(key), /\bfix(?:ed|es)?\b/i, `${key} must not claim a remedy`);
  }
});

test("every AI act uses its dedicated catalog phrase", () => {
  assert.equal(phraseForAct("known_fix"), phrase("ai-known-fix"));
  assert.equal(phraseForAct("unresolved"), phrase("ai-unresolved"));
  assert.equal(phraseForAct("ambiguous"), phrase("ai-ambiguous"));
});

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

// The retired mascot voice, as it appeared in shipped strings and comments.
const RETIRED_VOICE = /\[Rocky\]|, question\b|\bgood good\b|\bbad bad\b|\bI remember\b|\bI not\b|good trade|\beridian|\bhis ears\b|\bmy ears\b/i;
const SHIPPED_TEXT = /\.(?:ts|js|mjs|css|html|bash|sh|ps1)$/;

test("shipped sources carry no retired voice marker", () => {
  const testDir = `${sep}src${sep}test${sep}`;
  const shipped = [
    ...filesUnder(join(packageRoot, "src")).filter((path) => !path.includes(testDir)),
    ...filesUnder(join(packageRoot, "assets", "gui")),
  ].filter((path) => SHIPPED_TEXT.test(path));
  assert.ok(shipped.length > 50, "expected to scan the shipped sources");
  const hits: string[] = [];
  for (const path of shipped) {
    readFileSync(path, "utf8").split(/\r?\n/).forEach((line, index) => {
      if (RETIRED_VOICE.test(line)) hits.push(`${relative(packageRoot, path)}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
});

test("the voice skill asset no longer ships", () => {
  assert.equal(existsSync(join(packageRoot, "skills", "rocky-voice")), false);
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { files: string[] };
  assert.equal(pkg.files.some((entry) => entry.startsWith("skills/")), false);
});
