/**
 * Does a command's first word name something that exists on PATH, question
 *
 * This exists for exactly one caller decision: whether a repeated failure is
 * a typo rather than a real error. It answers in three states on purpose.
 * `unknown` is not a soft `not-found` -- it means the walk could not answer,
 * and a caller that suppresses on `unknown` would silence real errors every
 * time PATH is unreadable. Absence of evidence is not evidence.
 *
 * Deliberately not checked: the POSIX execute bit. A non-executable file
 * named `git` sitting in PATH answers `found`, the caller shows its hint,
 * and that is today's behaviour -- the failure mode of guessing wrong here
 * is silence, which is worse.
 */

import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute } from "node:path";

export type PathLookup = "found" | "not-found" | "unknown";

/**
 * Shell keywords open a compound command; they were never a PATH lookup, and
 * a failing `if ...` or `for ...` is not a typo. Answering `not-found` for
 * these would suppress the hint on real, structured failures.
 */
const SHELL_KEYWORDS = new Set([
  "if", "then", "else", "elif", "fi",
  "for", "while", "until", "do", "done",
  "case", "esac", "select", "function",
  "time", "coproc", "[[", "]]", "{", "}", "!",
]);

/** The first whitespace-delimited token, or empty when there is none. */
export function firstWord(cmd: string): string {
  const trimmed = cmd.trim();
  if (trimmed === "") return "";
  const end = trimmed.search(/\s/);
  return end === -1 ? trimmed : trimmed.slice(0, end);
}

/** Candidate filenames for one word: bare on POSIX, PATHEXT-expanded on Windows. */
function candidateNames(word: string, env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== "win32") return [word];
  if (/\.[^.\\/]+$/.test(word)) return [word];
  const pathext = env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  const extensions = pathext.split(";").map((e) => e.trim()).filter((e) => e !== "");
  return [word, ...extensions.map((ext) => `${word}${ext}`)];
}

/** True when `candidate` names an existing regular file. Never throws. */
function isFile(candidate: string): boolean {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function resolvesOnPath(word: string, env: NodeJS.ProcessEnv = process.env): PathLookup {
  if (word === "") return "unknown";
  if (SHELL_KEYWORDS.has(word)) return "unknown";

  try {
    // An explicit path was never a PATH lookup: check it where it points.
    if (word.includes("/") || word.includes("\\") || isAbsolute(word)) {
      return candidateNames(word, env).some(isFile) ? "found" : "not-found";
    }

    const raw = env.PATH ?? env.Path;
    if (raw === undefined || raw.trim() === "") return "unknown";
    const dirs = raw.split(delimiter).map((d) => d.trim()).filter((d) => d !== "");
    if (dirs.length === 0) return "unknown";

    const names = candidateNames(word, env);
    for (const dir of dirs) {
      for (const name of names) {
        if (isFile(`${dir}${dir.endsWith("/") || dir.endsWith("\\") ? "" : "/"}${name}`)) return "found";
      }
    }
    return "not-found";
  } catch {
    return "unknown";
  }
}