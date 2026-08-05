import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const skillRoot = join(packageRoot, "skills", "rocky-voice");

interface SkillDocument {
  frontmatter: Readonly<Record<string, string>>;
  body: string;
}

function parseFlatMappings(source: string): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || !line.includes(":")) continue;
    const separator = line.indexOf(":");
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    if (rawValue === "") continue;
    const quoted = rawValue.match(/^(["'])(.*)\1$/);
    values[key] = quoted === null
      ? rawValue
      : quoted[1] === '"'
        ? JSON.parse(rawValue) as string
        : quoted[2] ?? "";
  }
  return values;
}

function parseSkill(source: string): SkillDocument {
  const normalized = source.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(match, "SKILL.md must contain narrow YAML frontmatter");
  return {
    frontmatter: parseFlatMappings(match[1] ?? ""),
    body: match[2] ?? "",
  };
}

test("skill parser preserves identical semantics for LF and CRLF bytes", () => {
  const lf = readFileSync(join(skillRoot, "SKILL.md"), "utf8").replaceAll("\r\n", "\n");
  const crlf = lf.replaceAll("\n", "\r\n");

  assert.deepEqual(parseSkill(crlf), parseSkill(lf));
});

function filesBelow(root: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...filesBelow(root, relative));
    else found.push(relative);
  }
  return found.sort();
}

test("rocky-voice ships as the exact minimal instruction-only skill", () => {
  const source = readFileSync(join(skillRoot, "SKILL.md"), "utf8");
  const skill = parseSkill(source);
  const metadata = parseFlatMappings(readFileSync(join(skillRoot, "agents", "openai.yaml"), "utf8"));

  assert.deepEqual(skill.frontmatter, {
    name: "rocky-voice",
    description: "Use when the user asks Rocky to narrate or interpret Rocky recall, failure, fix, or stats output.",
  });
  assert.deepEqual(metadata, {
    display_name: "Rocky Voice",
    short_description: "Narrate Rocky memory in Rocky's voice",
    default_prompt: "Use $rocky-voice to narrate this Rocky recall result without changing its technical evidence.",
  });
  assert.deepEqual(filesBelow(skillRoot), ["SKILL.md", "agents/openai.yaml"]);
  assert.equal(/\b(?:scripts|references|dependencies|policy):/m.test(source), false);
  assert.ok(skill.body.trim().split(/\s+/u).length < 200);
});

test("rocky-voice response contract contains no accidental question or visual language", () => {
  const { body } = parseSkill(readFileSync(join(skillRoot, "SKILL.md"), "utf8"));
  const questionMarks = [...body.matchAll(/\?/gu)];
  const visualVerbs = [...body.matchAll(/\b(?:see|sees|seeing|saw|look|looks|looking|watch|watches|watching|observe|observes|observing)\b/giu)];

  assert.equal(questionMarks.length, 1);
  assert.match(body.split("\n").find((line) => line.includes("?")) ?? "", /never use `\?`/);
  assert.deepEqual(visualVerbs.map((match) => match[0].toLowerCase()), ["sees"]);
  assert.match(body.split("\n").find((line) => /\bsees\b/i.test(line)) ?? "", /never that he sees/);

  const exampleOutputs = [...body.matchAll(/```(?:text)?\n([\s\S]*?)```/gu)].map((match) => match[1] ?? "");
  for (const example of exampleOutputs) {
    assert.equal(example.includes("?"), false);
    assert.equal(/\b(?:see|sees|seeing|saw|look|looks|looking|watch|watches|watching|observe|observes|observing)\b/iu.test(example), false);
  }
});
