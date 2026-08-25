import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { tokens } from "./fingerprint.js";
import { gitFirstTouch } from "./git-diff.js";

export type RungSource = "catalog" | "ast" | "def" | "comment" | "test" | "git";

export interface Rung {
  source: RungSource;
  finding: string;
}

export type StopReason = "evidence-exhausted" | "max-hops" | "library-boundary" | "cycle";

export interface LadderResult {
  rungs: readonly Rung[];
  stopReason: StopReason;
}

export const MAX_LADDER_HOPS = 5;

export const TEACH_NEIGHBOR_CAP_BYTES = 64 * 1024;

/**
 * Default bounded neighbor reader shared by the CLI, MCP, and TUI surfaces so
 * hop 3 (relative imports) and hop 5 (`src/test/<basename>.test.ts`) fire in
 * production. Each candidate resolves against the process cwd and the file's
 * own directory, reads with a 64 KB byte cap, and any missing, oversized, or
 * unreadable file is a miss (undefined), never an error -- the same
 * fail-open discipline the MCP surface applies to its own reads.
 */
export function defaultTeachNeighbor(file: string): (relPath: string) => string | undefined {
  return (relPath: string): string | undefined => {
    if (typeof relPath !== "string" || relPath.length === 0) return undefined;
    const candidates: string[] = [];
    if (isAbsolute(relPath)) candidates.push(relPath);
    candidates.push(resolve(process.cwd(), relPath), resolve(dirname(file), relPath));
    for (const candidate of candidates) {
      try {
        const stat = statSync(candidate);
        if (!stat.isFile() || stat.size > TEACH_NEIGHBOR_CAP_BYTES) continue;
        return readFileSync(candidate, "utf8");
      } catch {
        // Fail open: an unreadable neighbor is a miss, never an error.
      }
    }
    return undefined;
  };
}

export interface BuildLadderInput {
  file: string;
  startLine: number;
  endLine: number;
  fileText: string;
  readNeighbor?: (relPath: string) => string | undefined;
  git?: typeof gitFirstTouch;
}

/**
 * JavaScript keyword set used to keep control-flow / declaration tokens out of
 * the callee scan (hop 3). `if (`, `for (` and friends are calls only in the
 * shallowest reading; naming them as a callee would fabricate a definition.
 */
const KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "do", "else", "return", "function", "typeof",
  "new", "delete", "void", "in", "of", "instanceof", "throw", "case", "default", "break",
  "continue", "yield", "await", "async", "class", "extends", "super", "import", "export",
]);

interface Construct {
  re: RegExp;
  finding: string;
}

/**
 * Fixed construct catalog for hop 1. Each entry matches a shape of code and
 * names the concern it usually serves; the finding template interpolates the
 * matched token (`{token}`) and the file line (`{line}`). Order matters:
 * more specific shapes are listed first so a line with several constructs
 * yields the one that says the most.
 *
 * ponytail: regex/token heuristics only, no real parser; if the ladder ever
 * needs to disambiguate nested calls, string literals, or shadowed names,
 * replace this catalog and the hop-3 callee scan with a real AST walk (a
 * zero-dependency scanner, or an upstream JS parser behind a feature flag).
 */
const CONSTRUCTS: readonly Construct[] = [
  { re: /\bawait\b/, finding: "async because await used at line {line}" },
  { re: /\bPromise\.all\b/, finding: "Promise.all ({token}) runs promises together" },
  { re: /\?\./, finding: "optional chaining ({token}) guards null access" },
  { re: /\?[^?].*:/, finding: "ternary ({token}) picks between values" },
  { re: /\.where\(/, finding: "({token}) filters rows" },
  { re: /\.filter\(/, finding: "({token}) filters records" },
  { re: /\btry\s*\{/, finding: "try/catch guards ({token})" },
  { re: /\bcatch\s*\(/, finding: "try/catch guards ({token})" },
  { re: /\.\.\./, finding: "spread ({token}) copies or merges" },
  { re: /`/, finding: "template literal ({token}) interpolates a string" },
  { re: /\b(?:const|let|var)\s*\{/, finding: "destructuring ({token}) pulls fields out" },
  { re: /\b(?:const|let|var)\s*\[/, finding: "destructuring ({token}) pulls fields out" },
  { re: /(\w[\w$]*)\s*=>/, finding: "arrow callback ({token}) passed as argument" },
];

/** Token-level fallback for hop 1 when no line matches the construct regexes. */
const TOKEN_FALLBACK: readonly { token: string; finding: string }[] = [
  { token: "await", finding: "async because await used in selection" },
  { token: "where", finding: "(.where()) filters rows" },
  { token: "filter", finding: "(.filter()) filters records" },
  { token: "try", finding: "try/catch guards an operation" },
  { token: "catch", finding: "try/catch guards an operation" },
  { token: "promise", finding: "Promise.all runs promises together" },
];

const FN_RE = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/;
const ARROW_RE = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/;
const METHOD_RE = /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/;

interface DefinitionSite {
  path: string;
  line: number;
  jsdoc?: string;
}

type CalleeResolution =
  | { name: string; site: DefinitionSite; inFile: boolean }
  | "boundary"
  | undefined;

export function buildLadder(input: BuildLadderInput): LadderResult {
  const { file, fileText, readNeighbor, git = gitFirstTouch } = input;
  const lines = fileText.split(/\r?\n/);
  const total = lines.length;
  const selStart = Math.max(1, Math.min(input.startLine, total || 1));
  const selEnd = Math.max(selStart, Math.min(input.endLine, total || 1));
  const selection = lines.slice(selStart - 1, selEnd).join("\n");

  const rungs: Rung[] = [];
  const usedDefSites = new Set<string>();
  let enclosingName: string | undefined;
  let calleeName: string | undefined;

  const add = (rung: Rung): boolean => {
    rungs.push(rung);
    return rungs.length >= MAX_LADDER_HOPS;
  };

  // Hop 1: what construct is this.
  const catalog = hopCatalog(selection, selStart);
  if (catalog !== undefined && add(catalog)) return { rungs, stopReason: "max-hops" };

  // Hop 2: why is it here -- the enclosing function.
  const ast = hopAst(lines, selStart, selection);
  if (ast !== undefined) {
    enclosingName = ast.name;
    usedDefSites.add(`${file}|${ast.line}|${ast.name}`);
    if (add({ source: "ast", finding: ast.finding })) return { rungs, stopReason: "max-hops" };
  }

  // Hop 3: what does the callee do -- definition / JSDoc / neighbor.
  const def = resolveCallee(selection, file, fileText, readNeighbor);
  if (def === "boundary") return { rungs, stopReason: "library-boundary" };
  if (def !== undefined) {
    calleeName = def.name;
    const siteKey = `${def.site.path}|${def.site.line}|${def.name}`;
    if (usedDefSites.has(siteKey)) return { rungs, stopReason: "cycle" };
    usedDefSites.add(siteKey);
    const jsdocClause = def.site.jsdoc !== undefined ? `; JSDoc: ${def.site.jsdoc}` : "";
    const where = def.inFile ? `line ${def.site.line}` : `${def.site.path} at line ${def.site.line}`;
    const finding = `callee ${def.name} defined ${def.inFile ? "at " : "in "}${where}${jsdocClause}`;
    if (add({ source: "def", finding })) return { rungs, stopReason: "max-hops" };
  }

  // Hop 4: why at this exact point -- nearest comment above the selection.
  const comment = hopComment(lines, selStart);
  if (comment !== undefined && add(comment)) return { rungs, stopReason: "max-hops" };

  // Hop 5: intent -- tests naming the symbol, first git log -L commit.
  const testRung = hopTest(file, enclosingName, calleeName, readNeighbor);
  if (testRung !== undefined && add(testRung)) return { rungs, stopReason: "max-hops" };
  const gitRung = hopGit(file, selStart, selEnd, git);
  if (gitRung !== undefined && add(gitRung)) return { rungs, stopReason: "max-hops" };

  return { rungs, stopReason: "evidence-exhausted" };
}

function fillTemplate(template: string, token: string, line: number): string {
  return template.replaceAll("{token}", token).replaceAll("{line}", String(line));
}

function hopCatalog(selection: string, selStart: number): Rung | undefined {
  const selLines = selection.split(/\r?\n/);
  for (let i = 0; i < selLines.length; i += 1) {
    const line = selLines[i] ?? "";
    for (const c of CONSTRUCTS) {
      const m = c.re.exec(line);
      if (m !== null) {
        const token = (m[1] ?? m[0] ?? "").trim();
        return { source: "catalog", finding: fillTemplate(c.finding, token, selStart + i) };
      }
    }
  }
  const bag = tokens(selection);
  for (const t of TOKEN_FALLBACK) {
    if (bag.has(t.token)) {
      return { source: "catalog", finding: fillTemplate(t.finding, t.token, selStart) };
    }
  }
  return undefined;
}

function hopAst(lines: readonly string[], selStart: number, selection: string): Rung & { name: string; line: number } | undefined {
  for (let i = selStart - 2; i >= 0; i -= 1) {
    const line = lines[i] ?? "";
    let name: string | undefined;
    const fn = FN_RE.exec(line);
    if (fn !== null) name = fn[1];
    if (name === undefined) {
      const arrow = ARROW_RE.exec(line);
      if (arrow !== null && !KEYWORDS.has(arrow[1] ?? "")) name = arrow[1];
    }
    if (name === undefined) {
      const method = METHOD_RE.exec(line);
      if (method !== null && !KEYWORDS.has(method[1] ?? "")) name = method[1];
    }
    if (name !== undefined) {
      const args = argsInSelection(selection);
      const clause = args !== undefined ? `; called with ${args}` : "";
      return { source: "ast", name, line: i + 1, finding: `inside ${name}${clause}` };
    }
  }
  return undefined;
}

function argsInSelection(selection: string): string | undefined {
  const m = /\(([^()]*)\)/.exec(selection);
  if (m === null) return undefined;
  const args = (m[1] ?? "").trim();
  return args.length > 0 ? args : undefined;
}

function resolveCallee(
  selection: string,
  file: string,
  fileText: string,
  readNeighbor: ((relPath: string) => string | undefined) | undefined,
): CalleeResolution {
  const name = firstCallee(selection);
  if (name === undefined) return undefined;
  const inFile = findDefinitionInText(name, fileText);
  if (inFile !== undefined) {
    return { name, site: { path: file, line: inFile.line, jsdoc: inFile.jsdoc }, inFile: true };
  }
  const imports = collectImports(fileText);
  const imp = imports.find((i) => i.names.includes(name));
  if (imp === undefined) return undefined;
  if (isRelativeSpecifier(imp.specifier)) {
    if (readNeighbor === undefined) return undefined;
    const rel = resolveRelativePath(file, imp.specifier);
    const neighbor = readNeighbor(rel);
    if (neighbor === undefined) return undefined;
    const found = findDefinitionInText(name, neighbor);
    if (found === undefined) return undefined;
    return { name, site: { path: rel, line: found.line, jsdoc: found.jsdoc }, inFile: false };
  }
  return "boundary";
}

function firstCallee(selection: string): string | undefined {
  const re = /([A-Za-z_$][\w$]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(selection)) !== null) {
    const name = m[1] ?? "";
    if (KEYWORDS.has(name)) continue;
    return name;
  }
  return undefined;
}

function findDefinitionInText(name: string, text: string): { line: number; jsdoc?: string } | undefined {
  const n = escapeRegExp(name);
  const fnRe = new RegExp(`^(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+${n}\\s*\\(`);
  const constRe = new RegExp(`^(?:export\\s+)?(?:const|let|var)\\s+${n}\\s*=\\s*(?:async\\s*)?(?:\\(|function)`);
  const assignRe = new RegExp(`^\\s*${n}\\s*=\\s*(?:async\\s*)?(?:\\(|function)`);
  const methodRe = new RegExp(`^\\s*(?:async\\s+)?${n}\\s*\\([^)]*\\)\\s*\\{`);
  const defLines = text.split(/\r?\n/);
  for (let i = 0; i < defLines.length; i += 1) {
    const line = defLines[i] ?? "";
    if (fnRe.test(line) || constRe.test(line) || assignRe.test(line) || methodRe.test(line)) {
      let jsdoc: string | undefined;
      if (i > 0) {
        const above = (defLines[i - 1] ?? "").trim();
        if (isCommentLine(above)) jsdoc = above.slice(0, 120);
      }
      return { line: i + 1, jsdoc };
    }
  }
  return undefined;
}

function hopComment(lines: readonly string[], selStart: number): Rung | undefined {
  const floor = Math.max(0, selStart - 11);
  for (let i = selStart - 2; i >= floor; i -= 1) {
    const line = lines[i];
    if (line === undefined) break;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (isCommentLine(line)) {
      return { source: "comment", finding: `nearest comment "${trimmed.slice(0, 80)}"` };
    }
  }
  return undefined;
}

function hopTest(
  file: string,
  enclosingName: string | undefined,
  calleeName: string | undefined,
  readNeighbor: ((relPath: string) => string | undefined) | undefined,
): Rung | undefined {
  if (readNeighbor === undefined) return undefined;
  const names = new Set<string>();
  if (enclosingName !== undefined) names.add(enclosingName);
  if (calleeName !== undefined) names.add(calleeName);
  if (names.size === 0) return undefined;
  const base = basenameWithoutExt(file);
  const candidates = [`src/test/${base}.test.ts`, `src/test/${base}.spec.ts`];
  for (const cand of candidates) {
    const content = readNeighbor(cand);
    if (content === undefined || content.length === 0) continue;
    const testLines = content.split(/\r?\n/);
    for (let i = 0; i < testLines.length; i += 1) {
      const line = testLines[i] ?? "";
      for (const name of names) {
        if (new RegExp(`\\b${escapeRegExp(name)}\\b`).test(line)) {
          const text = line.trim().slice(0, 80);
          return { source: "test", finding: `test "${cand}:${i + 1}: ${text}"` };
        }
      }
    }
  }
  return undefined;
}

function hopGit(
  file: string,
  startLine: number,
  endLine: number,
  git: ((file: string, startLine: number, endLine: number, cwd?: string) => { commit: string; subject: string } | undefined) | undefined,
): Rung | undefined {
  if (git === undefined) return undefined;
  const result = git(file, startLine, endLine);
  if (result === undefined) return undefined;
  const subject = result.subject.trim();
  if (subject.length === 0) return undefined;
  return { source: "git", finding: `first touched in ${result.commit}: ${subject}` };
}

interface ImportLine {
  names: string[];
  specifier: string;
}

function collectImports(text: string): ImportLine[] {
  const out: ImportLine[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!/^import\b/.test(trimmed)) continue;
    const named = /^import\s+(?:type\s+)?(?:([A-Za-z_$][\w$]*)\s*,\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/.exec(trimmed);
    if (named !== null) {
      const names = (named[2] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => (s.split(/\s+as\s+/)[0] ?? "").trim());
      if (named[1] !== undefined) names.unshift(named[1]);
      out.push({ names, specifier: named[3] ?? "" });
      continue;
    }
    const simple = /^import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s+from\s*["']([^"']+)["']/.exec(trimmed);
    if (simple !== null) {
      out.push({ names: [simple[1] ?? ""], specifier: simple[2] ?? "" });
    }
  }
  return out;
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function resolveRelativePath(file: string, specifier: string): string {
  const f = file.replace(/\\/g, "/");
  const base = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "";
  const parts: string[] = [];
  for (const seg of `${base}/${specifier}`.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join("/");
}

function basenameWithoutExt(file: string): string {
  const f = file.replace(/\\/g, "/");
  const slash = f.lastIndexOf("/");
  const leaf = slash === -1 ? f : f.slice(slash + 1);
  const dot = leaf.lastIndexOf(".");
  return dot === -1 ? leaf : leaf.slice(0, dot);
}

function isCommentLine(line: string): boolean {
  return /^\s*(\/\/|\/\*|\*)/.test(line);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
