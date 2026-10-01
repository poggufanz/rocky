/**
 * Multi-hop reference tracing and code context assembly.
 *
 * Traverses reference chains across files:
 *   Selection in file C -> calls function in file B -> calls implementation in file A
 *
 * Implements bounded, cycle-safe, secret-redacted evidence collection for Explain
 * and code-grounded answering.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { redactSecretsAtBoundary } from "./redact.js";
import {
  calleeNames,
  collectImports,
  enclosingFunction,
  findDefinitionInText,
  isMeaningfulCommentLine,
  isRelativeSpecifier,
  resolveRelativePath,
} from "./teach-ladder.js";
import { gitFirstTouch, GIT_DIFF_MAX_BYTES, GIT_DIFF_TIMEOUT_MS } from "./git-diff.js";

export const TRACE_MAX_HOPS = 4;
export const TRACE_MAX_FILES = 8;
export const TRACE_MAX_DEFS = 8;
export const TRACE_MAX_CHARS = 20_000;
export const TRACE_DEF_SNIPPET_CHARS = 1_500;
export const TRACE_TEST_MAX = 2;
export const TRACE_TEST_CHARS = 2_500;

export interface ReferenceLocation {
  file: string;
  line: number;
  symbol: string;
}

export type ReferenceNodeRole =
  | "selection"
  | "enclosing"
  | "intermediary"
  | "core-implementation"
  | "config"
  | "boundary"
  | "unresolved";

export interface ReferenceNode {
  id: string;
  file: string;
  line: number;
  symbol: string;
  kind: "selection" | "enclosing" | "definition" | "config" | "boundary" | "unresolved";
  role: ReferenceNodeRole;
  snippet: string;
  jsdoc?: string;
  commit?: string;
}

export interface ReferenceEdge {
  from: { file: string; symbol: string; line?: number };
  to: { file: string; symbol: string; line?: number };
  kind: "calls" | "imports" | "delegates" | "reads-config";
}

export interface ReferenceTraceResult {
  selection: {
    file: string;
    start: number;
    end: number;
    snippet: string;
    commit?: string;
  };
  enclosing?: {
    name: string;
    start: number;
    end: number;
    snippet: string;
  };
  nodes: readonly ReferenceNode[];
  edges: readonly ReferenceEdge[];
  referenceChain: readonly string[];
  comments: readonly string[];
  tests: readonly { file: string; line: number; snippet: string; symbol: string }[];
  git?: { commit: string; subject: string };
  stopReasons: readonly string[];
  evidenceText: string;
  truncated: boolean;
}

export interface TraceReferencesOptions {
  root?: string;
  file: string;
  startLine: number;
  endLine: number;
  fileText?: string;
  commit?: string;
  readNeighbor?: (relPath: string) => string | undefined;
  readCommitFile?: (file: string, commit: string, cwd?: string) => string | undefined;
  maxHops?: number;
  maxFiles?: number;
  maxDefs?: number;
  budgetChars?: number;
}

const TEST_FILE_RE = /(?:\.test\.[tj]sx?|\.spec\.[tj]sx?|Test\.php)$/;

export { isMeaningfulCommentLine };

/** Extracts meaningful comments immediately above a line range. */
export function extractNearestComments(lines: readonly string[], startLine: number, maxLines = 10): string[] {
  const comments: string[] = [];
  const floor = Math.max(0, startLine - 1 - maxLines);
  for (let i = startLine - 2; i >= floor; i -= 1) {
    const raw = lines[i];
    if (raw === undefined) break;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (!/^\s*(\/\/|\/\*|\*|#|<!--)/.test(raw)) break;
    if (isMeaningfulCommentLine(raw)) {
      comments.unshift(trimmed);
    }
  }
  return comments;
}

export interface PhpUse {
  name: string;
  fqcn: string;
}

export function collectPhpUses(text: string): PhpUse[] {
  const out: PhpUse[] = [];
  const re = /^\s*use\s+([A-Za-z0-9_\\]+)(?:\s+as\s+([A-Za-z0-9_]+))?\s*;/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const fqcn = m[1] ?? "";
    if (fqcn.includes("{")) continue;
    out.push({ name: m[2] ?? fqcn.split("\\").pop() ?? fqcn, fqcn });
  }
  return out;
}

export function resolvePhpClass(
  fullOrRel: string,
  fqcn: string,
  root?: string,
): { path: string; content: string } | undefined {
  let dir = dirname(fullOrRel);
  if (root !== undefined && !isAbsolute(dir)) {
    dir = resolve(root, dir);
  }
  let prefixes: Record<string, string> = {};
  for (let up = 0; up < 6; up += 1) {
    const composerPath = join(dir, "composer.json");
    if (existsSync(composerPath)) {
      try {
        const composer = JSON.parse(readFileSync(composerPath, "utf8")) as {
          autoload?: { ["psr-4"]?: Record<string, string | string[]> };
          ["autoload-dev"]?: { ["psr-4"]?: Record<string, string | string[]> };
        };
        for (const section of [composer.autoload?.["psr-4"], composer["autoload-dev"]?.["psr-4"]]) {
          for (const [prefix, target] of Object.entries(section ?? {})) {
            prefixes[prefix.replace(/\\+$/, "")] = Array.isArray(target) ? target[0] ?? "" : target;
          }
        }
      } catch {
        // malformed composer.json falls back
      }
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (Object.keys(prefixes).length === 0) prefixes = { App: "app/", Tests: "tests/" };

  const match = Object.keys(prefixes)
    .sort((a, b) => b.length - a.length)
    .find((prefix) => fqcn === prefix || fqcn.startsWith(`${prefix}\\`));
  if (match === undefined) return undefined;
  const rel = `${prefixes[match]}${fqcn.slice(match.length + 1).replace(/\\/g, "/")}.php`;
  const candidate = resolve(dir, rel);
  try {
    const info = statSync(candidate);
    if (!info.isFile() || info.size > 64 * 1024) return undefined;
    return { path: rel.replace(/\\/g, "/"), content: readFileSync(candidate, "utf8") };
  } catch {
    return undefined;
  }
}

export function phpDefinition(
  name: string,
  text: string,
): { line: number; kind: "class" | "method" } | undefined {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lines = text.split(/\r?\n/);
  const classRe = new RegExp(`^\\s*(?:abstract\\s+|final\\s+)?(?:class|interface|trait|enum)\\s+${n}\\b`);
  for (let i = 0; i < lines.length; i += 1) {
    if (classRe.test(lines[i] ?? "")) return { line: i + 1, kind: "class" };
  }
  const methodRe = new RegExp(`^\\s*(?:public|protected|private|static|final|abstract|\\s)*function\\s+${n}\\s*\\(`);
  for (let i = 0; i < lines.length; i += 1) {
    if (methodRe.test(lines[i] ?? "")) return { line: i + 1, kind: "method" };
  }
  return undefined;
}

/** Tries to read file content via `git show <commit>:<file>` safely. */
export function defaultReadCommitFile(file: string, commit: string, cwd?: string): string | undefined {
  if (!commit || !/^[0-9a-fA-F]{4,128}$/.test(commit)) return undefined;
  try {
    const normFile = file.replace(/\\/g, "/").replace(/^\.?\//, "");
    const result = spawnSync("git", ["show", `${commit}:${normFile}`], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: GIT_DIFF_MAX_BYTES * 4,
      timeout: GIT_DIFF_TIMEOUT_MS,
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
      ...(cwd !== undefined ? { cwd } : {}),
    });
    if (result.status === 0 && !result.error && typeof result.stdout === "string") {
      return result.stdout;
    }
  } catch {
    // Fail open
  }
  return undefined;
}

/** Reads a neighbor file with extension fallbacks (.ts, .js, .tsx, .jsx, .php). */
function tryReadNeighbor(
  reader: (relPath: string) => string | undefined,
  specifierPath: string,
): { path: string; content: string } | undefined {
  const norm = specifierPath.replace(/\\/g, "/");
  const tries = [norm];
  if (norm.endsWith(".js")) tries.push(`${norm.slice(0, -3)}.ts`, `${norm.slice(0, -3)}.tsx`);
  if (norm.endsWith(".jsx")) tries.push(`${norm.slice(0, -4)}.tsx`, `${norm.slice(0, -4)}.ts`);
  if (!/\.[a-z0-9]+$/i.test(norm)) {
    tries.push(
      `${norm}.ts`,
      `${norm}.tsx`,
      `${norm}.js`,
      `${norm}.jsx`,
      `${norm}.php`,
      `${norm}/index.ts`,
      `${norm}/index.tsx`,
      `${norm}/index.js`,
    );
  }
  for (const cand of tries) {
    const content = reader(cand);
    if (content !== undefined && content.length > 0) {
      return { path: cand, content };
    }
  }
  return undefined;
}

/** Extracts a representative definition slice (signature + body up to max lines). */
function extractDefinitionBody(
  lines: readonly string[],
  defLine: number,
  maxLines = 30,
): string {
  const from = Math.max(0, defLine - 1);
  const to = Math.min(lines.length, defLine - 1 + maxLines);
  return lines.slice(from, to).join("\n");
}

interface TraversalTarget {
  file: string;
  symbol: string;
  fileText: string;
  caller: { file: string; symbol: string; line?: number };
  depth: number;
}

/**
 * Executes multi-hop reference tracing from an initial code selection.
 */
export function traceReferences(options: TraceReferencesOptions): ReferenceTraceResult {
  const root = options.root ?? process.cwd();
  const relFile = options.file.replace(/\\/g, "/");
  const maxHops = options.maxHops ?? TRACE_MAX_HOPS;
  const maxFiles = options.maxFiles ?? TRACE_MAX_FILES;
  const maxDefs = options.maxDefs ?? TRACE_MAX_DEFS;
  const budgetChars = options.budgetChars ?? TRACE_MAX_CHARS;

  const readCommit = options.readCommitFile ?? defaultReadCommitFile;
  const defaultReader = (candidate: string): string | undefined => {
    try {
      const full = isAbsolute(candidate) ? candidate : resolve(root, candidate);
      if (!existsSync(full)) return undefined;
      const st = statSync(full);
      if (!st.isFile() || st.size > 128 * 1024) return undefined;
      return readFileSync(full, "utf8");
    } catch {
      return undefined;
    }
  };
  const readNeighbor = options.readNeighbor ?? defaultReader;

  // Resolve file text: prefer provided text -> commit revision -> working tree
  let fileText = options.fileText;
  if (fileText === undefined && options.commit) {
    fileText = readCommit(relFile, options.commit, root);
  }
  if (fileText === undefined) {
    fileText = readNeighbor(relFile) ?? "";
  }

  const lines = fileText.split(/\r?\n/);
  const totalLines = lines.length;
  const start = Math.max(1, Math.min(options.startLine, totalLines || 1));
  const end = Math.max(start, Math.min(options.endLine, totalLines || 1));
  const selectionSnippet = lines.slice(start - 1, end).join("\n");

  const nodes: ReferenceNode[] = [];
  const edges: ReferenceEdge[] = [];
  const stopReasons: string[] = [];
  const visitedSymbols = new Set<string>(); // file#symbol
  const visitedFiles = new Set<string>([relFile]);

  // Record selection node
  nodes.push({
    id: `${relFile}:${start}-${end}:selection`,
    file: relFile,
    line: start,
    symbol: "selection",
    kind: "selection",
    role: "selection",
    snippet: selectionSnippet,
    ...(options.commit ? { commit: options.commit } : {}),
  });

  // Enclosing function
  let enclosing: ReferenceTraceResult["enclosing"] | undefined;
  const enc = enclosingFunction(lines, start);
  if (enc !== undefined) {
    const encSnippet = lines.slice(enc.start - 1, enc.end).join("\n");
    enclosing = { name: enc.name, start: enc.start, end: enc.end, snippet: encSnippet };
    nodes.push({
      id: `${relFile}:${enc.start}:${enc.name}`,
      file: relFile,
      line: enc.start,
      symbol: enc.name,
      kind: "enclosing",
      role: "enclosing",
      snippet: encSnippet.slice(0, TRACE_DEF_SNIPPET_CHARS),
    });
  }

  // Identify symbols directly called or used in the selection
  const rawSymbols = calleeNames(selectionSnippet);
  const isPhp = relFile.endsWith(".php");
  const phpUses = isPhp ? collectPhpUses(fileText) : [];

  // Check PHP method calls e.g. ->method() or ::method()
  if (isPhp) {
    const methodRe = /(?:->|::)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
    let mm: RegExpExecArray | null;
    while ((mm = methodRe.exec(selectionSnippet)) !== null) {
      const name = mm[1] ?? "";
      if (name && !rawSymbols.includes(name)) rawSymbols.push(name);
    }
  }

  // Also check symbols mentioned from imports
  const rootImports = collectImports(fileText);
  const wordIn = (name: string): boolean =>
    new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(selectionSnippet);
  for (const imp of rootImports) {
    for (const name of imp.names) {
      if (!rawSymbols.includes(name) && wordIn(name)) rawSymbols.push(name);
    }
  }
  for (const use of phpUses) {
    if (!rawSymbols.includes(use.name) && wordIn(use.name)) rawSymbols.push(use.name);
  }

  // Queue for BFS traversal
  const queue: TraversalTarget[] = [];
  for (const sym of rawSymbols) {
    queue.push({
      file: relFile,
      symbol: sym,
      fileText,
      caller: { file: relFile, symbol: enc?.name ?? "selection", line: start },
      depth: 1,
    });
  }

  const defNodesCollected: ReferenceNode[] = [];
  const fileCache = new Map<string, string>([[relFile, fileText]]);

  while (queue.length > 0 && defNodesCollected.length < maxDefs) {
    const target = queue.shift()!;
    const symKey = `${target.file}#${target.symbol}`;
    if (visitedSymbols.has(symKey)) {
      if (!stopReasons.includes("cycle-detected")) stopReasons.push("cycle-detected");
      continue;
    }
    visitedSymbols.add(symKey);

    if (target.depth > maxHops) {
      if (!stopReasons.includes("max-hops-reached")) stopReasons.push("max-hops-reached");
      continue;
    }

    if (visitedFiles.size > maxFiles) {
      if (!stopReasons.includes("max-files-reached")) stopReasons.push("max-files-reached");
      break;
    }

    const currFile = target.file;
    const currText = target.fileText;
    const currLines = currText.split(/\r?\n/);

    // 1. Try finding definition in the current file
    let defSite = findDefinitionInText(target.symbol, currText);
    let defFile = currFile;
    let defText = currText;
    let defLines = currLines;
    let isExternal = false;

    // 2. If not found in current file, check imports / php uses
    if (defSite === undefined) {
      const imports = collectImports(currText);
      const imp = imports.find((i) => i.names.includes(target.symbol));
      if (imp !== undefined) {
        if (isRelativeSpecifier(imp.specifier)) {
          const neighborRel = resolveRelativePath(currFile, imp.specifier);
          let neighbor = fileCache.get(neighborRel);
          if (neighbor === undefined) {
            if (options.commit) {
              neighbor = readCommit(neighborRel, options.commit, root);
            }
            if (neighbor === undefined) {
              const read = tryReadNeighbor(readNeighbor, neighborRel);
              if (read !== undefined) {
                neighbor = read.content;
                defFile = read.path;
              }
            } else {
              defFile = neighborRel;
            }
          }
          if (neighbor !== undefined) {
            fileCache.set(defFile, neighbor);
            visitedFiles.add(defFile);
            defText = neighbor;
            defLines = defText.split(/\r?\n/);
            const binding = imp.bindings?.find((b) => b.local === target.symbol);
            const symInTarget = (binding && binding.imported !== "default" && binding.imported !== "*")
              ? binding.imported
              : target.symbol;
            defSite = findDefinitionInText(symInTarget, defText);
            if (defSite === undefined && (binding?.imported === "default" || symInTarget === "default")) {
              const defaultRe = /^\s*(?:export\s+default|module\.exports\s*=)/;
              for (let i = 0; i < defLines.length; i += 1) {
                if (defaultRe.test(defLines[i] ?? "")) {
                  defSite = { line: i + 1 };
                  break;
                }
              }
            }
          }
        } else {
          isExternal = true;
        }
      } else if (currFile.endsWith(".php")) {
        const uses = collectPhpUses(currText);
        const use = uses.find((u) => u.name === target.symbol);
        if (use !== undefined) {
          const resolved = resolvePhpClass(currFile, use.fqcn, root);
          if (resolved !== undefined) {
            defFile = resolved.path;
            defText = resolved.content;
            defLines = defText.split(/\r?\n/);
            visitedFiles.add(defFile);
            fileCache.set(defFile, defText);
            const phpDef = phpDefinition(target.symbol, defText);
            if (phpDef !== undefined) {
              defSite = { line: phpDef.line };
            }
          }
        } else {
          // Check if method in current class
          const phpMethod = phpDefinition(target.symbol, currText);
          if (phpMethod !== undefined) {
            defSite = { line: phpMethod.line };
          } else {
            // Check if method in any of the imported use classes
            for (const u of uses) {
              const resolved = resolvePhpClass(currFile, u.fqcn, root);
              if (resolved !== undefined) {
                const methodDef = phpDefinition(target.symbol, resolved.content);
                if (methodDef !== undefined) {
                  defFile = resolved.path;
                  defText = resolved.content;
                  defLines = defText.split(/\r?\n/);
                  visitedFiles.add(defFile);
                  fileCache.set(defFile, defText);
                  defSite = { line: methodDef.line };
                  break;
                }
              }
            }
          }
          // Sibling class in same directory (same namespace)
          if (defSite === undefined) {
            const dir = dirname(currFile).replace(/\\/g, "/");
            const siblingRel = dir === "." ? `${target.symbol}.php` : `${dir}/${target.symbol}.php`;
            let neighbor = fileCache.get(siblingRel);
            if (neighbor === undefined) {
              const read = tryReadNeighbor(readNeighbor, siblingRel);
              if (read !== undefined) {
                neighbor = read.content;
                defFile = read.path;
              }
            } else {
              defFile = siblingRel;
            }
            if (neighbor !== undefined) {
              fileCache.set(defFile, neighbor);
              visitedFiles.add(defFile);
              defText = neighbor;
              defLines = defText.split(/\r?\n/);
              const phpDef = phpDefinition(target.symbol, defText);
              if (phpDef !== undefined) {
                defSite = { line: phpDef.line };
              }
            }
          }
        }
      }
    }

    if (isExternal) {
      nodes.push({
        id: `external:${target.symbol}`,
        file: "external-library",
        line: 0,
        symbol: target.symbol,
        kind: "boundary",
        role: "boundary",
        snippet: `External dependency boundary for "${target.symbol}"`,
      });
      edges.push({
        from: target.caller,
        to: { file: "external-library", symbol: target.symbol, line: 0 },
        kind: "delegates",
      });
      if (!stopReasons.includes("library-boundary")) stopReasons.push("library-boundary");
      continue;
    }

    if (defSite === undefined) {
      nodes.push({
        id: `unresolved:${target.symbol}`,
        file: currFile,
        line: 0,
        symbol: target.symbol,
        kind: "unresolved",
        role: "unresolved",
        snippet: `Unresolved reference to "${target.symbol}"`,
      });
      if (!stopReasons.includes("unresolved-target")) stopReasons.push("unresolved-target");
      continue;
    }

    // Extract definition body and inspect its calls
    const body = extractDefinitionBody(defLines, defSite.line);
    const calleesInDef = calleeNames(body).filter((name) => name !== target.symbol);
    if (defFile.endsWith(".php")) {
      const phpMethodRe = /(?:->|::)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
      let pmm: RegExpExecArray | null;
      while ((pmm = phpMethodRe.exec(body)) !== null) {
        const mname = pmm[1] ?? "";
        if (mname && !calleesInDef.includes(mname) && mname !== target.symbol) {
          calleesInDef.push(mname);
        }
      }
      const phpUsesInDef = collectPhpUses(defText);
      for (const u of phpUsesInDef) {
        if (!calleesInDef.includes(u.name) && new RegExp(`\\b${u.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(body)) {
          calleesInDef.push(u.name);
        }
      }
    }

    // If this definition delegates to other functions, it is an "intermediary";
    // otherwise if it's a leaf implementation, it's a "core-implementation".
    const role: ReferenceNodeRole = calleesInDef.length > 0 ? "intermediary" : "core-implementation";

    const defNode: ReferenceNode = {
      id: `${defFile}:${defSite.line}:${target.symbol}`,
      file: defFile,
      line: defSite.line,
      symbol: target.symbol,
      kind: "definition",
      role,
      snippet: body.slice(0, TRACE_DEF_SNIPPET_CHARS),
      ...(defSite.jsdoc ? { jsdoc: defSite.jsdoc } : {}),
      ...(options.commit ? { commit: options.commit } : {}),
    };
    nodes.push(defNode);
    defNodesCollected.push(defNode);

    edges.push({
      from: target.caller,
      to: { file: defFile, symbol: target.symbol, line: defSite.line },
      kind: target.file === defFile ? "calls" : "delegates",
    });

    // Enqueue downstream references (multi-hop traversal)
    if (calleesInDef.length > 0 && target.depth < maxHops) {
      for (const nextSym of calleesInDef) {
        queue.push({
          file: defFile,
          symbol: nextSym,
          fileText: defText,
          caller: { file: defFile, symbol: target.symbol, line: defSite.line },
          depth: target.depth + 1,
        });
      }
    }
  }

  // Build reference chain string array
  // E.g. ["a.ts:10:handle", "b.ts:25:service", "c.ts:50:execute"]
  const referenceChain: string[] = [];
  if (edges.length > 0) {
    const visitedEdgeKeys = new Set<string>();
    for (const edge of edges) {
      const fromStr = `${edge.from.file}:${edge.from.symbol}`;
      const toStr = `${edge.to.file}:${edge.to.line ?? 0}:${edge.to.symbol}`;
      const key = `${fromStr}->${toStr}`;
      if (!visitedEdgeKeys.has(key)) {
        visitedEdgeKeys.add(key);
        if (!referenceChain.includes(fromStr)) referenceChain.push(fromStr);
        if (!referenceChain.includes(toStr)) referenceChain.push(toStr);
      }
    }
  }

  // Extract nearest comments above selection
  const comments = extractNearestComments(lines, start);

  // Search tests for symbols
  const allSymbols = Array.from(new Set([
    ...rawSymbols,
    ...defNodesCollected.map((d) => d.symbol),
    ...(enclosing ? [enclosing.name] : []),
  ]));
  const tests: Array<{ file: string; line: number; snippet: string; symbol: string }> = [];
  if (allSymbols.length > 0) {
    const testDirs = [
      resolve(root, "src", "test"),
      resolve(root, "tests"),
      resolve(root, "test"),
      resolve(dirname(relFile), "test"),
    ];
    let testFound = 0;
    for (const tdir of testDirs) {
      if (testFound >= TRACE_TEST_MAX) break;
      let entries: string[] = [];
      try {
        entries = readdirSync(tdir).filter((name) => TEST_FILE_RE.test(name));
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (testFound >= TRACE_TEST_MAX) break;
        const testPath = join(tdir, entry);
        let testContent = "";
        try {
          if (statSync(testPath).size > 64 * 1024) continue;
          testContent = readFileSync(testPath, "utf8");
        } catch {
          continue;
        }
        const testLines = testContent.split(/\r?\n/);
        for (let i = 0; i < testLines.length; i += 1) {
          const tLine = testLines[i] ?? "";
          const matchSym = allSymbols.find((s) => new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(tLine));
          if (matchSym !== undefined) {
            const from = Math.max(0, i - 2);
            const to = Math.min(testLines.length, i + 5);
            const relTestPath = relative(root, testPath).replace(/\\/g, "/");
            tests.push({
              file: relTestPath,
              line: i + 1,
              symbol: matchSym,
              snippet: testLines.slice(from, to).join("\n"),
            });
            testFound += 1;
            break;
          }
        }
      }
    }
  }

  // Git first touch
  const first = gitFirstTouch(relFile, start, end, root);
  const git = first !== undefined ? { commit: first.commit, subject: first.subject } : undefined;

  // Build evidence blocks for model context
  const blocks: string[] = [];
  let spent = 0;
  const addBlock = (label: string, body: string, cap: number): void => {
    const remaining = budgetChars - spent;
    if (remaining < 200) return;
    const cut = body.length > Math.min(cap, remaining) ? body.slice(0, Math.min(cap, remaining)) : body;
    const block = `${label}\n${cut}`;
    blocks.push(block);
    spent += block.length + 2;
  };

  addBlock(`=== selection ${relFile}:${start}-${end} ===`, selectionSnippet, 2_000);

  if (lines.length <= 80) {
    addBlock(`=== file ${relFile} (whole, ${lines.length} lines) ===`, fileText, budgetChars / 2);
  } else if (enclosing !== undefined) {
    const from = Math.max(0, enc!.start - 4);
    const to = Math.min(lines.length, enc!.end + 3);
    addBlock(`=== enclosing function ${enclosing.name} (${relFile}:${from + 1}-${to}) ===`, lines.slice(from, to).join("\n"), budgetChars / 2);
  } else {
    const from = Math.max(0, start - 1 - 25);
    const to = Math.min(lines.length, end + 25);
    addBlock(`=== file ${relFile} (lines ${from + 1}-${to} of ${lines.length}; the selection sits inside) ===`, lines.slice(from, to).join("\n"), budgetChars / 3);
  }

  if (referenceChain.length > 0) {
    const chainLines = edges.map((e) => `  ${e.from.file}:${e.from.symbol} -> ${e.to.file}:${e.to.line ?? 0}:${e.to.symbol} (${e.kind})`);
    addBlock(`=== reference chain ===`, chainLines.join("\n"), 1_000);
  }

  for (const defNode of defNodesCollected) {
    const roleTag = defNode.role ? ` [${defNode.role}]` : "";
    const jsdocPart = defNode.jsdoc ? `${defNode.jsdoc}\n` : "";
    addBlock(`=== definition ${defNode.symbol} (${defNode.file}:${defNode.line})${roleTag} ===`, `${jsdocPart}${defNode.snippet}`, TRACE_DEF_SNIPPET_CHARS);
  }

  if (comments.length > 0) {
    addBlock(`=== comment above the selection ===`, comments.join("\n"), 600);
  }

  for (const t of tests) {
    addBlock(`=== test ${t.file}:${t.line} mentioning ${t.symbol} ===`, t.snippet, TRACE_TEST_CHARS);
  }

  if (git !== undefined) {
    addBlock(`=== git ===`, `first touched in ${git.commit}: ${git.subject}`, 300);
  }

  const joinedText = redactSecretsAtBoundary(blocks.join("\n\n"));
  const truncated = spent >= budgetChars;

  return {
    selection: {
      file: relFile,
      start,
      end,
      snippet: selectionSnippet,
      ...(options.commit ? { commit: options.commit } : {}),
    },
    ...(enclosing ? { enclosing } : {}),
    nodes,
    edges,
    referenceChain,
    comments,
    tests,
    ...(git ? { git } : {}),
    stopReasons,
    evidenceText: joinedText,
    truncated,
  };
}
