import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runGit } from "../core/exec.js";
import { matchesGlob, parseInvariants } from "../core/invariants.js";
import { parseNoArgs, reportCliUsage } from "./cli-args.js";
import { detail, say } from "../ui/rocky.js";

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export async function invariantsCommand(argv: readonly string[] = [], cwd = process.cwd()): Promise<number> {
  try {
    parseNoArgs(argv, "rocky invariants");
  } catch (error) {
    const code = reportCliUsage(error, say, detail);
    if (code !== undefined) return code;
    throw error;
  }
  const top = await runGit(["-C", cwd, "rev-parse", "--show-toplevel"], undefined, { timeoutMs: GIT_TIMEOUT_MS });
  if (top.code !== 0) {
    say("no git repo here. invariants live in repo root. bad bad.");
    return 1;
  }
  const root = top.stdout.trim();
  let text: string;
  try {
    text = readFileSync(join(root, ".rocky", "invariants.md"), "utf8");
  } catch {
    say("no invariant file yet. you write .rocky/invariants.md, I remember what it guards, question");
    return 0;
  }
  const { notes, errors } = parseInvariants(text);
  const filesResult = await runGit(["-C", root, "ls-files"], undefined, { timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: GIT_MAX_OUTPUT_BYTES });
  const files = filesResult.code === 0 ? filesResult.stdout.split("\n").filter((line) => line.length > 0) : [];
  say(`I hear ${notes.length} invariant${notes.length === 1 ? "" : "s"}.`);
  for (const note of notes) {
    console.log(`invariant: ${note.invariant}`);
    console.log(`  guarded by: ${note.guardedBy.join(", ")}`);
    if (note.why !== undefined) console.log(`  why: ${note.why}`);
    for (const pattern of note.guardedBy) {
      if (files.length > 0 && !files.some((file) => matchesGlob(pattern, file))) {
        say(`glob "${pattern}" guards nothing here. typo, question`);
      }
    }
  }
  for (const error of errors) detail(`  skipped block: ${error}`);
  return 0;
}
