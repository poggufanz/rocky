#!/usr/bin/env node
// Dev script: count Rocky's hook entries in Claude Code settings files without
// printing any of their content.
//
// Usage:
//   node scripts/settings-shape.mjs [file...]
//
// With no file it reads ~/.claude/settings.json and, when CLAUDE_CONFIG_DIR is
// set, $CLAUDE_CONFIG_DIR/settings.json. Per file it prints one line:
//   <path>: bytes=<n> sha256=<first 12 hex> agent=<a> gate=<g> desk=<d>
// or `<path>: missing` / `<path>: unreadable`. Only the byte count, a hash
// prefix, and three counts leave the process, never the file's text.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const COUNTED = [
  ["agent", "hook agent-event claude-code"],
  ["gate", "hook gate-event claude-code"],
  ["desk", "desk-hook claude-code"],
];

function defaultFiles() {
  const files = [join(homedir(), ".claude", "settings.json")];
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (configDir) files.push(join(configDir, "settings.json"));
  return files;
}

/** Each path once, in order, so a config dir that is the default dir prints one line. */
function unique(paths) {
  const seen = new Set();
  return paths.filter((path) => {
    const key = resolve(path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Every string `command` under `value`, wherever hooks nest it. */
function* commandsIn(value) {
  if (Array.isArray(value)) {
    for (const item of value) yield* commandsIn(item);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "command" && typeof child === "string") yield child;
    else yield* commandsIn(child);
  }
}

function countHooks(settings) {
  const commands = [...commandsIn(settings?.hooks)];
  return COUNTED.map(([name, needle]) => `${name}=${commands.filter((command) => command.includes(needle)).length}`);
}

function describe(path) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    return `${path}: ${error?.code === "ENOENT" ? "missing" : "unreadable"}`;
  }
  let settings;
  try {
    settings = JSON.parse(bytes.toString("utf8"));
  } catch {
    return `${path}: unreadable`;
  }
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  return `${path}: bytes=${bytes.length} sha256=${digest} ${countHooks(settings).join(" ")}`;
}

const requested = process.argv.slice(2);
for (const path of unique(requested.length > 0 ? requested : defaultFiles())) {
  console.log(describe(path));
}
