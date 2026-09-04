/**
 * Rocky's localhost GUI server.
 *
 * Binds loopback only. Every launch mints a fresh token that the page carries
 * in its URL fragment and sends back on each API call, so another tab on this
 * machine cannot read the memory by guessing the port. Reads only: no route
 * here writes evidence.
 *
 * The one exception to no-egress is `POST /api/ask`, the BYOK proxy. It exists
 * because browsers cannot call model providers cross-origin; the request is
 * forwarded from here instead, and only when the page supplies a key.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, resolve, sep } from "node:path";

import { loadMemoryChecked } from "../core/memory-read.js";
import { redactSecretsAtBoundary } from "../core/redact.js";
import { publicSettings, readSettings, writeSettings } from "./settings.js";
import { providerFor, providerList } from "./models-dev.js";
import { deriveHome } from "../core/home-data.js";
import { elapsed } from "../ui/rocky.js";
import { fileIndex, getCachedDiff, groupMomentsByChange, defaultDiffIo, lineOverlapPredicate, parsePatch, type DiffRow } from "../core/compare-data.js";
import { resolveContext } from "../core/context-resolve.js";
import { filteredFiles, TEACH_MAX_LINES } from "../core/file-filter.js";
import { repoForPath, type RepoCache } from "../core/repo-groups.js";
import { teachLookup } from "../core/teach.js";
import { buildLadder, calleeNames, collectImports, defaultTeachNeighbor, enclosingFunction, findDefinitionInText, isRelativeSpecifier, resolveRelativePath } from "../core/teach-ladder.js";
import { gitFirstTouch, resolveCommitDiff } from "../core/git-diff.js";
import { bundleGroups, splitRowsByFile, BUNDLE_MAX_FILES, type BundleInput } from "../core/bundle-groups.js";
import {
  gapRungFor,
  renderLadderCard,
  renderLadderExpanded,
  renderWitnessCard,
} from "../core/teach-render.js";
import { resolveRefer, escapeRegExp, type ReferWitness } from "../core/refer-resolve.js";

export const DEFAULT_GUI_PORT = 7777;
const READ_CAP_BYTES = 2 * 1024 * 1024;
const MAX_BODY_BYTES = 256 * 1024;
const ASK_TIMEOUT_MS = 60_000;
const MAX_PROMPT_CHARS = 24_000;
const MAX_ASK_IN_FLIGHT = 2;

let askInFlight = 0;
let bundleCache: { key: string; payload: { bundles: unknown[]; unattributed: number } } | null = null;
let bundleInFlight: { key: string; promise: Promise<{ bundles: unknown[]; unattributed: number }> } | null = null;

/**
 * The fallback rules every BYOK answer is bound by when the spec file is not
 * on disk, prepended here rather than in the page so a browser cannot drop
 * them.
 *
 * Ported from the owner's teach agent spec (assets/teach-agent.md), minus
 * every instruction that
 * needs a tool. This model has no shell, no git, and no filesystem: it sees
 * the snippet and whatever Rocky already holds, and nothing else. Telling it
 * to walk five hops and cite `git log -L` would only teach it to invent
 * citations, which is the one failure this whole surface exists to prevent.
 */
const TEACH_RULES = [
  "You explain why a code snippet exists. You are a witness, not a judge, and you do not invent.",
  "",
  "Output language: Indonesian.",
  "",
  "HARD STOP: you have no shell, no git, no database and no filesystem. You see only what is",
  "quoted below. NEVER claim you ran a command, read another file, or queried a database.",
  "NEVER imply you inspected live data. If a reason would need evidence you were not given,",
  "say so and stop there.",
  "",
  "Keep two tracks separate, and do not merge them into one essay:",
  "  KODE    why this construct is written this way in THIS file",
  "  BISNIS  why this behaviour exists for the product",
  "",
  "Every claim must point at something in the text you were given: a line, a quoted comment,",
  "or a record Rocky recorded. No support means the claim does not exist: do not write it.",
  "NEVER say `best practice`, `lebih rapi`, or `idiomatic` without naming the alternative it",
  "was chosen over. NEVER paraphrase a comment that is already quoted: quote it.",
  "NEVER present your reconstruction as something an agent stated when the code was written.",
  "",
  "Answer in this shape, omitting any line you have no support for:",
  "  KODE",
  "    why 1  …",
  "    stop   …",
  "  BISNIS",
  "    why 1  …",
  "    stop   …",
  "",
  "Two sentences per why, at most. Thin evidence is an answer: an honest two-line card beats",
  "a five-line story. Say plainly when you cannot tell.",
].join("\n");

const ASSET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "gui");

/** The owner's spec, whole, next to the dash assets so the package ships it. */
const TEACH_SPEC_CAP_BYTES = 64 * 1024;
const teachSpec: Partial<Record<"id" | "en", string | null>> = {};

/**
 * teach-agent.md is the system prompt, read whole at request time (cached
 * after the first read) so editing the file edits the investigator. The
 * settings pick the language: id reads teach-agent.md, en its english twin.
 * The spec assumes tools this model does not have, so an environment note
 * rides ahead of it; where the spec says walk hops with a shell, the model
 * works only from the quoted evidence. TEACH_RULES stays as the fallback for
 * a spec that is not on disk.
 */
const TEACH_ENV = [
  "Environment note for this run: you have no shell, no git, no database and no filesystem.",
  "Rocky walks the hops for you and quotes what it found after the rules, selection first:",
  "the enclosing function, the definitions of the symbols the selection uses, the comment",
  "above it, the tests that name those symbols, and the git commit that first touched the",
  "lines. Cite only what is quoted; never claim you ran anything.",
].join("\n");

const PACK_BUDGET_CHARS = 20_000;
const PACK_DEF_CHARS = 1_200;
const PACK_DEF_MAX = 3;
const PACK_TEST_CHARS = 2_500;
const PACK_TEST_MAX = 2;
const PACK_WHOLE_FILE_LINES = 80;
const PACK_WINDOW_PAD_LINES = 25;

/** A js specifier points at .js on disk as often as .ts, so both are tried. */
function readNeighborFile(neighbor: (relPath: string) => string | undefined, rel: string): string | undefined {
  const tries = [rel];
  if (rel.endsWith(".js")) tries.push(`${rel.slice(0, -3)}.ts`);
  if (!/\.[a-z]+$/.test(rel)) tries.push(`${rel}.ts`, `${rel}.js`, `${rel}.php`);
  for (const candidate of tries) {
    const content = neighbor(candidate);
    if (content !== undefined) return content;
  }
  return undefined;
}

/** Test files live under a handful of names across ecosystems. */
const TEST_FILE_RE = /(?:\.test\.[tj]s|\.spec\.[tj]s|Test\.php)$/;

/** A PHP `use` line, as the pack reads it: the short name the code mentions
 *  and the class it points at. Grouped uses (`use App\{A, B}`) stay unparsed. */
interface PhpUse {
  name: string;
  fqcn: string;
}

function collectPhpUses(text: string): PhpUse[] {
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

/**
 * PSR-4 resolution: the nearest composer.json above the file maps namespace
 * prefixes to directories; without one, the App/ and Tests/ conventions carry
 * Laravel-shaped projects. Bounded read, a miss is a miss, never an error.
 */
function resolvePhpClass(full: string, fqcn: string): { path: string; content: string } | undefined {
  let dir = dirname(full);
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
        // a composer.json that will not parse falls through to conventions
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

/** Where a PHP class or one of its methods is declared, for the pack to quote. */
function phpDefinition(
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

/**
 * The ask model has no eyes, so rocky digs for it, selection-first and in a
 * written order: the selection itself, the function enclosing it (or the whole
 * file when it is short), the definitions of the symbols the selection
 * actually uses, the comment above, the tests that name those symbols, and
 * the first commit that touched the lines. Everything is bounded, and
 * redaction happens on the joined pack before any of it may leave the machine.
 */
function evidencePack(full: string, rel: string, start: number, end: number): string {
  try {
    const info = statSync(full);
    if (!info.isFile() || info.size > READ_CAP_BYTES) return "";
    const fileText = readFileSync(full, "utf8");
    const lines = fileText.split(/\r?\n/);
    const selection = lines.slice(Math.max(0, start - 1), end).join("\n");

    // budget-aware assembly: a late block is dropped whole before the early
    // ones lose a character, because the order above is the priority
    const blocks: string[] = [];
    let spent = 0;
    const addBlock = (label: string, body: string, cap: number): void => {
      const remaining = PACK_BUDGET_CHARS - spent;
      if (remaining < 200) return;
      const cut = body.length > Math.min(cap, remaining) ? body.slice(0, Math.min(cap, remaining)) : body;
      const block = `${label}\n${cut}`;
      blocks.push(block);
      spent += block.length + 2;
    };

    addBlock(`=== selection ${rel}:${start}-${end} ===`, selection, 2_000);

    if (lines.length <= PACK_WHOLE_FILE_LINES) {
      addBlock(`=== file ${rel} (whole, ${lines.length} lines) ===`, fileText, PACK_BUDGET_CHARS / 2);
    } else {
      const enc = enclosingFunction(lines, start);
      if (enc !== undefined) {
        const from = Math.max(0, enc.start - 4);
        const to = Math.min(lines.length, enc.end + 3);
        addBlock(
          `=== enclosing function ${enc.name} (${rel}:${from + 1}-${to}) ===`,
          lines.slice(from, to).join("\n"),
          PACK_BUDGET_CHARS / 2,
        );
      } else {
        const from = Math.max(0, start - 1 - PACK_WINDOW_PAD_LINES);
        const to = Math.min(lines.length, end + PACK_WINDOW_PAD_LINES);
        addBlock(
          `=== file ${rel} (lines ${from + 1}-${to} of ${lines.length}; the selection sits inside) ===`,
          lines.slice(from, to).join("\n"),
          PACK_BUDGET_CHARS / 3,
        );
      }
    }

    // the symbols the selection actually uses: calls, plus imported names that
    // appear in it -- their definitions open, never a whole neighbour file.
    // php names its neighbours in use statements instead of imports.
    const imports = collectImports(fileText);
    const symbols = [...calleeNames(selection)];
    const wordIn = (name: string): boolean =>
      new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(selection);
    for (const imp of imports) {
      for (const name of imp.names) {
        if (!symbols.includes(name) && wordIn(name)) symbols.push(name);
      }
    }
    const php = rel.endsWith(".php");
    const phpUses = php ? collectPhpUses(fileText) : [];
    for (const use of phpUses) {
      if (!symbols.includes(use.name) && wordIn(use.name)) symbols.push(use.name);
    }

    const neighbor = defaultTeachNeighbor(full);
    const phpResolved: Array<{ path: string; content: string }> = [];
    let defs = 0;
    for (const name of symbols) {
      if (defs >= PACK_DEF_MAX) break;
      const inFile = findDefinitionInText(name, fileText);
      if (inFile !== undefined) {
        const from = Math.max(0, inFile.line - 2);
        const body = `${inFile.jsdoc !== undefined ? `${inFile.jsdoc}\n` : ""}${lines.slice(from, inFile.line + 6).join("\n")}`;
        addBlock(`=== definition ${name} (${rel}:${inFile.line}) ===`, body, PACK_DEF_CHARS);
        defs += 1;
        continue;
      }
      const imp = imports.find((i) => i.names.includes(name));
      if (imp !== undefined && isRelativeSpecifier(imp.specifier)) {
        const neighborRel = resolveRelativePath(full, imp.specifier);
        const content = readNeighborFile(neighbor, neighborRel);
        if (content === undefined) continue;
        const found = findDefinitionInText(name, content);
        if (found === undefined) continue;
        const neighborLines = content.split(/\r?\n/);
        const from = Math.max(0, found.line - 2);
        const body = `${found.jsdoc !== undefined ? `${found.jsdoc}\n` : ""}${neighborLines.slice(from, found.line + 6).join("\n")}`;
        addBlock(`=== definition ${name} (${neighborRel}:${found.line}) ===`, body, PACK_DEF_CHARS);
        defs += 1;
        continue;
      }
      if (php) {
        const use = phpUses.find((u) => u.name === name);
        if (use === undefined) continue;
        const resolved = resolvePhpClass(full, use.fqcn);
        if (resolved === undefined) continue;
        phpResolved.push(resolved);
        const def = phpDefinition(name, resolved.content);
        if (def === undefined) continue;
        const phpLines = resolved.content.split(/\r?\n/);
        const from = Math.max(0, def.line - 2);
        addBlock(
          `=== definition ${name} (${resolved.path}:${def.line}) ===`,
          phpLines.slice(from, def.line + 8).join("\n"),
          PACK_DEF_CHARS,
        );
        defs += 1;
      }
    }

    // php member calls name methods; their definitions sit in this file or in
    // a class a use statement already resolved above
    if (php) {
      const methodRe = /(?:->|::)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
      const methods: string[] = [];
      let mm: RegExpExecArray | null;
      while ((mm = methodRe.exec(selection)) !== null) {
        const name = mm[1] ?? "";
        if (!methods.includes(name)) methods.push(name);
      }
      for (const method of methods) {
        if (defs >= PACK_DEF_MAX) break;
        const inFile = phpDefinition(method, fileText);
        if (inFile !== undefined) {
          const from = Math.max(0, inFile.line - 2);
          addBlock(`=== definition ${method} (${rel}:${inFile.line}) ===`, lines.slice(from, inFile.line + 8).join("\n"), PACK_DEF_CHARS);
          defs += 1;
          continue;
        }
        for (const f of phpResolved) {
          const def = phpDefinition(method, f.content);
          if (def === undefined) continue;
          const phpLines = f.content.split(/\r?\n/);
          const from = Math.max(0, def.line - 2);
          addBlock(`=== definition ${method} (${f.path}:${def.line}) ===`, phpLines.slice(from, def.line + 8).join("\n"), PACK_DEF_CHARS);
          defs += 1;
          break;
        }
      }
    }

    // the nearest comment above the selection often carries the why verbatim
    const comments: string[] = [];
    for (let i = start - 2; i >= Math.max(0, start - 11); i -= 1) {
      const trimmed = (lines[i] ?? "").trim();
      if (trimmed.length === 0) continue;
      if (!/^\s*(\/\/|\/\*|\*|#)/.test(lines[i] ?? "")) break;
      comments.unshift(trimmed);
    }
    if (comments.length > 0) addBlock(`=== comment above the selection ===`, comments.join("\n"), 600);

    // tests that name the symbol prove intent; the same-basename file is only
    // the fallback when no test mentions it. The file's own project is scanned
    // first; the launch cwd's test dirs count only when the file lives there.
    if (symbols.length > 0) {
      const dirs = [
        resolve(dirname(full), "..", "..", "src", "test"),
        resolve(dirname(full), "..", "..", "tests"),
        ...(confine(process.cwd(), full) !== undefined
          ? [resolve(process.cwd(), "src", "test"), resolve(process.cwd(), "tests")]
          : []),
      ];
      let found = 0;
      for (const dir of dirs) {
        if (found >= PACK_TEST_MAX) break;
        let entries: string[] = [];
        try {
          entries = readdirSync(dir).filter((name) => TEST_FILE_RE.test(name));
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (found >= PACK_TEST_MAX) break;
          let content: string;
          try {
            const path = join(dir, entry);
            if (statSync(path).size > 64 * 1024) continue;
            content = readFileSync(path, "utf8");
          } catch {
            continue;
          }
          const testLines = content.split(/\r?\n/);
          for (let i = 0; i < testLines.length; i += 1) {
            const hit = symbols.find((name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(testLines[i] ?? ""));
            if (hit === undefined) continue;
            const from = Math.max(0, i - 3);
            const to = Math.min(testLines.length, i + 4);
            addBlock(
              `=== test ${entry}:${i + 1} mentioning ${hit} ===`,
              testLines.slice(from, to).join("\n"),
              PACK_TEST_CHARS,
            );
            found += 1;
            break;
          }
        }
      }

      if (found === 0) {
        const base = rel.replace(/\\/g, "/").split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
        if (base) {
          for (const cand of [`src/test/${base}.test.ts`, `src/test/${base}.spec.ts`]) {
            const content = neighbor(cand);
            if (content !== undefined) {
              addBlock(`=== test ${cand} ===`, content, PACK_TEST_CHARS);
              break;
            }
          }
        }
      }
    }

    const first = gitFirstTouch(rel, Math.max(1, start), Math.max(1, end));
    if (first !== undefined) addBlock("=== git ===", `first touched in ${first.commit}: ${first.subject}`, 300);

    return blocks.join("\n\n");
  } catch {
    return "";
  }
}

function loadTeachSpec(lang: "id" | "en"): string {
  if (teachSpec[lang] === undefined) {
    try {
      const path = resolve(ASSET_ROOT, "..", lang === "en" ? "teach-agent.en.md" : "teach-agent.md");
      const raw = readFileSync(path, "utf8");
      teachSpec[lang] = Buffer.byteLength(raw) <= TEACH_SPEC_CAP_BYTES ? raw : null;
    } catch {
      teachSpec[lang] = null;
    }
  }
  return teachSpec[lang] ?? TEACH_RULES;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

/** Applied to every response: no store, no sniff, no referrer, no CORS at all. */
function baseHeaders(type: string): Record<string, string> {
  return {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, baseHeaders("application/json; charset=utf-8"));
  response.end(JSON.stringify(body));
}

/** 403 carries no detail: a prober learns nothing from which check failed. */
function forbid(response: ServerResponse): void {
  response.writeHead(403, baseHeaders("text/plain; charset=utf-8"));
  response.end("no");
}

/** Blocks DNS rebinding: a foreign name resolving here still fails the check. */
function hostAllowed(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/**
 * A path input may be read two ways: it sits inside the repo the server was
 * launched in, or memory already names it. The dash lists exactly what memory
 * names, so refusing such a read only breaks the page when rocky was launched
 * outside that file's tree.
 *
 * The comparison is case-insensitive on Windows because the filesystem is:
 * memory canonicalises paths to lower case, so a case-sensitive prefix test
 * refused the repo's own files and the page reported hearing nothing.
 */
function confine(root: string, candidate: string): string | undefined {
  const full = resolve(root, candidate);
  const fold = (value: string): string => (process.platform === "win32" ? value.toLowerCase() : value);
  const inside = fold(full) === fold(root) || fold(full).startsWith(fold(root) + sep);
  return inside ? full : undefined;
}

/** Memory already discloses these paths to the page, so reading one leaks nothing new. */
function witnessed(candidate: string): string | undefined {
  const norm = candidate.replace(/\\/g, "/");
  const heard = fileIndex(records().list).some((file) => file.path === norm);
  return heard ? norm : undefined;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function records(): { list: ReturnType<typeof loadMemoryChecked>["records"]; reason: string | undefined } {
  const loaded = loadMemoryChecked();
  // an incomplete read is disclosed, never passed off as full coverage
  const reason = loaded.coverage?.complete === false ? loaded.coverage.reason : undefined;
  return { list: loaded.records, reason };
}

const ago = (ts: number, now: number): string => {
  const delta = Math.max(0, now - ts);
  if (delta >= 86_400_000) return `${Math.floor(delta / 86_400_000)}d ago`;
  if (delta >= 3_600_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 60_000)}m ago`;
};

/** One moment as the GUI reads it: identity, labels, and its diff if any. */
function momentsFor(path: string, root: string, now: number) {
  const entry = fileIndex(records().list).find((file) => file.path === path);
  if (entry === undefined) return { changes: [], unattributed: [] };
  const flat = entry.recs.map((rec, index) => {
    const diff = getCachedDiff(path, rec, defaultDiffIo) ?? undefined;
    return {
      id: `${rec.ts}-${index}`,
      kind: rec.kind,
      source: rec.source,
      ts: rec.ts,
      ago: ago(rec.ts, now),
      machine: rec.machine,
      reason: rec.reason,
      summary: rec.summary,
      excerpt: rec.excerpt,
      intent: rec.intent,
      diff,
    };
  });
  return groupMomentsByChange(flat);
}

/** Flat moment list recovered from grouped output: compare, strict, and the
 *  picker need per-moment granularity with diffs intact. */
function flatMoments(grouped: ReturnType<typeof momentsFor>) {
  return [...grouped.changes.flatMap((c) => c.witnesses), ...grouped.unattributed];
}

/** Forwards one prompt to the provider the page names. OpenAI-compatible
 *  hosts and Anthropic differ only in header and body shape. When the page
 *  names the file its question is about, rocky digs first and quotes what it
 *  found: the model explains evidence, it does not have to imagine code. */
async function ask(body: Record<string, unknown>, root: string): Promise<{ status: number; payload: unknown }> {
  // endpoint, model and key all come off disk: the page never holds the secret
  const stored = readSettings();
  const endpoint = stored.endpoint;
  const key = stored.key;
  const model = stored.model;
  const raw = String(body.prompt ?? "");
  if (!endpoint || !key || !model || !raw) {
    return { status: 400, payload: { error: "rocky need endpoint, key, model in settings first" } };
  }
  if (askInFlight >= MAX_ASK_IN_FLIGHT) {
    return { status: 429, payload: { error: "rocky already asking. wait, question" } };
  }

  // This is the only text that leaves the machine, so it is redacted first:
  // a selected line can carry a key, and the provider must never see it.
  const asked = redactSecretsAtBoundary(
    raw.length > MAX_PROMPT_CHARS ? `${raw.slice(0, MAX_PROMPT_CHARS)}\n… cut, prompt long` : raw,
  );

  // the dig: whole file, imported neighbours, sibling test, first git touch --
  // the same boundary as any other read, then redacted like the prompt itself
  let pack = "";
  const rel = typeof body.path === "string" ? body.path : "";
  if (rel) {
    const full = confine(root, rel) ?? witnessed(rel);
    if (full !== undefined) {
      const start = Number(body.start ?? 1);
      const end = Number(body.end ?? start);
      const dug = evidencePack(full, rel, start, end);
      if (dug) pack = `\n\nEVIDENCE ROCKY GATHERED (quote only from this):\n${redactSecretsAtBoundary(dug)}`;
    }
  }

  // the rules ride here, not in the page, so a browser cannot drop them
  const prompt = `${TEACH_ENV}\n\n${loadTeachSpec(stored.lang)}\n\n---\n\n${asked}${pack}`;

  const anthropic = endpoint.includes("/v1/messages");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (anthropic) {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers.Authorization = `Bearer ${key}`;
  }

  const payload = anthropic
    ? { model, max_tokens: 1024, messages: [{ role: "user", content: prompt }] }
    : { model, max_tokens: 1024, messages: [{ role: "user", content: prompt }] };

  askInFlight += 1;
  try {
    const answer = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
    });
    const data = (await answer.json()) as Record<string, any>;
    if (!answer.ok) {
      return { status: answer.status, payload: { error: data?.error?.message ?? "provider refused" } };
    }
    const text = anthropic ? data?.content?.[0]?.text : data?.choices?.[0]?.message?.content;
    return { status: 200, payload: { text: typeof text === "string" ? text : "" } };
  } finally {
    askInFlight -= 1;
  }
}

async function serveAsset(pathname: string, response: ServerResponse): Promise<void> {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/assets\//, "");
  const full = confine(ASSET_ROOT, rel);
  if (full === undefined) return forbid(response);
  try {
    const body = await readFile(full);
    response.writeHead(200, baseHeaders(TYPES[extname(full)] ?? "application/octet-stream"));
    response.end(body);
  } catch {
    response.writeHead(404, baseHeaders("text/plain; charset=utf-8")).end("no");
  }
}

async function computeBundles(q = "", repoFilter: string | null = null): Promise<{ bundles: unknown[]; unattributed: number }> {
  const { list } = records();
  const lastRec = list[list.length - 1];
  const cacheKey = `${list.length}:${lastRec ? lastRec.ts : 0}:${q}:${repoFilter ?? ""}`;
  if (bundleCache && bundleCache.key === cacheKey) {
    return bundleCache.payload;
  }
  if (bundleInFlight && bundleInFlight.key === cacheKey) {
    return bundleInFlight.promise;
  }
  const promise = (async () => {
    const files = fileIndex(list);
    const shown = filteredFiles({ files, fquery: q });
    const repos: RepoCache = new Map();
    const inputs: BundleInput[] = [];
    for (const file of shown) {
      const repo = (await repoForPath(file.path, repos)) ?? "";
      if (repoFilter && repo !== repoFilter) continue;
      for (const rec of file.recs) {
        if (!repo) {
          inputs.push({
            path: file.path,
            repo: "",
            rec,
            diff: { rows: [] },
          });
          continue;
        }
        const diff = getCachedDiff(file.path, rec, defaultDiffIo);
        inputs.push({
          path: file.path,
          repo,
          rec,
          diff,
        });
      }
    }
    const result = bundleGroups(inputs);
    const payload = {
      bundles: result.bundles,
      unattributed: result.unattributed.length,
    };
    bundleCache = { key: cacheKey, payload };
    return payload;
  })();

  bundleInFlight = { key: cacheKey, promise };
  try {
    return await promise;
  } finally {
    if (bundleInFlight?.key === cacheKey) {
      bundleInFlight = null;
    }
  }
}

async function handleApi(
  pathname: string,
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
  root: string,
): Promise<void> {
  const now = Date.now();

  if (pathname === "/api/home") {
    const { list, reason } = records();
    return sendJson(response, 200, deriveHome(list, reason, now));
  }

  if (pathname === "/api/files") {
    const files = fileIndex(records().list);
    const q = url.searchParams.get("q") ?? "";
    const shown = filteredFiles({ files, fquery: q });
    // one cache per answer: the dash's files share the same few repo walks
    const repos: RepoCache = new Map();
    return sendJson(response, 200, await Promise.all(shown.map(async (f) => {
      // the newest record names what this file was last heard doing, so the
      // repo filter can card each group with its latest intent and age
      let newest: (typeof f.recs)[number] | undefined;
      for (const rec of f.recs) {
        if (newest === undefined || (rec.ts ?? 0) > (newest.ts ?? 0)) newest = rec;
      }
      const rawLabel = (newest?.summary ?? newest?.reason ?? newest?.excerpt ?? newest?.intent ?? newest?.kind ?? "")
        .replace(/\s+/g, " ")
        .trim();
      const span = newest ? elapsed(Math.max(0, now - (newest.ts ?? 0))) : "";
      return {
        path: f.path,
        count: f.count,
        repo: await repoForPath(f.path, repos),
        last: newest ? {
          label: redactSecretsAtBoundary(rawLabel).slice(0, 140),
          agoText: span === "just now" ? span : `${span} ago`,
          ts: newest.ts ?? 0,
        } : null,
      };
    })));
  }

  if (pathname === "/api/file") {
    const rel = url.searchParams.get("path") ?? "";
    const full = confine(root, rel) ?? witnessed(rel);
    if (full === undefined) return forbid(response);
    try {
      const info = await stat(full);
      if (!info.isFile() || info.size > READ_CAP_BYTES) throw new Error("bounded read miss");
      const raw = (await readFile(full, "utf8")).split(/\r?\n/);
      const capped = raw.length > TEACH_MAX_LINES ? raw.slice(0, TEACH_MAX_LINES) : raw;
      return sendJson(response, 200, { lines: capped, truncated: raw.length > TEACH_MAX_LINES });
    } catch {
      return sendJson(response, 200, { lines: [], missing: true });
    }
  }

  if (pathname === "/api/moments") {
    const rel = url.searchParams.get("path") ?? "";
    const all = flatMoments(momentsFor(rel, root, now));
    if (url.searchParams.get("strict") !== "1") return sendJson(response, 200, all);
    // strict keeps only the moments touching the same lines as the other side
    const near = url.searchParams.get("near");
    const anchor = all.find((m) => m.id === near);
    const related = lineOverlapPredicate(rel);
    const kept = anchor === undefined
      ? all.filter((m) => m.diff !== undefined)
      : all.filter((m) => m.id === anchor.id || related(anchor as never, m as never));
    return sendJson(response, 200, kept);
  }

  if (pathname === "/api/compare") {
    const rel = url.searchParams.get("path") ?? "";
    const a = url.searchParams.get("a");
    const b = url.searchParams.get("b");
    const grouped = momentsFor(rel, root, now);
    if (a === null || b === null) return sendJson(response, 200, grouped);
    const all = flatMoments(grouped);
    const pick = (id: string) => {
      const found = all.find((m) => m.id === id);
      return found ? { record: found, diff: found.diff ?? null } : null;
    };
    return sendJson(response, 200, { A: pick(a), B: pick(b) });
  }

  if (pathname === "/api/bundles") {
    const q = url.searchParams.get("q") ?? "";
    const repoFilter = url.searchParams.get("repo");
    const payload = await computeBundles(q, repoFilter);
    return sendJson(response, 200, payload);
  }

  if (pathname === "/api/bundle") {
    const commit = url.searchParams.get("commit");
    if (!commit || !/^[0-9a-fA-F]{4,128}$/.test(commit)) {
      return sendJson(response, 400, { error: "rocky needs a commit sha, question" });
    }
    const resolved = resolveCommitDiff({ sha: commit, cwd: root });
    if (resolved === undefined) {
      return sendJson(response, 200, null);
    }
    const rows = parsePatch(resolved.diff);
    const byFile = splitRowsByFile(rows);
    const files = Array.from(byFile.entries()).map(([path, fileRows]) => ({ path, rows: fileRows }));
    const total = files.length;
    const capped = files.slice(0, BUNDLE_MAX_FILES);
    const truncated = resolved.truncated || total > BUNDLE_MAX_FILES;
    return sendJson(response, 200, {
      commit: resolved.commit,
      files: capped,
      truncated,
      total,
    });
  }

  if (pathname === "/api/refer") {
    const rel = url.searchParams.get("path");
    if (!rel) {
      return sendJson(response, 400, { error: "rocky needs a file path, question" });
    }
    const full = confine(root, rel) ?? witnessed(rel);
    if (full === undefined) return forbid(response);

    let fileText = "";
    try {
      const info = await stat(full);
      if (!info.isFile() || info.size > READ_CAP_BYTES) return sendJson(response, 200, null);
      const raw = (await readFile(full, "utf8")).split(/\r?\n/);
      const capped = raw.length > TEACH_MAX_LINES ? raw.slice(0, TEACH_MAX_LINES) : raw;
      fileText = capped.join("\n");
    } catch {
      return sendJson(response, 200, null);
    }

    const lineParam = url.searchParams.get("line");
    const line = lineParam !== null && !isNaN(Number(lineParam)) && Number(lineParam) > 0
      ? Math.floor(Number(lineParam))
      : 1;
    const symbolParam = url.searchParams.get("symbol");
    const symbol = symbolParam !== null && symbolParam.trim().length > 0 ? symbolParam.trim() : undefined;

    let targetSymbol = symbol ?? "";
    if (!targetSymbol) {
      const lines = fileText.split(/\r?\n/);
      const lineIndex = line - 1;
      const lineText = lineIndex >= 0 && lineIndex < lines.length ? (lines[lineIndex] ?? "") : "";
      const callees = calleeNames(lineText);
      targetSymbol = callees[0] ?? "";
    }

    const witnesses: ReferWitness[] = [];
    const texts = new Map<string, string>();

    if (targetSymbol.length > 0) {
      const symbolRe = new RegExp(`\\b${escapeRegExp(targetSymbol)}\\b`);
      const { list } = records();
      const files = fileIndex(list);
      let matchedFiles = 0;
      for (const file of files) {
        if (matchedFiles >= 20) break;
        let matchedText: string | undefined;
        for (const rec of file.recs) {
          for (const candidate of [rec.excerpt, rec.reason, rec.intent]) {
            if (typeof candidate === "string" && symbolRe.test(candidate)) {
              matchedText = candidate;
              break;
            }
          }
          if (matchedText !== undefined) break;
        }

        if (matchedText !== undefined) {
          matchedFiles += 1;
          const matchLine = matchedText.split(/\r?\n/).find((l) => symbolRe.test(l)) ?? matchedText;
          witnesses.push({
            path: file.path,
            line: 0,
            text: matchLine.trim(),
          });

          if (texts.size < 10) {
            const neighborFull = confine(root, file.path) ?? witnessed(file.path);
            if (neighborFull !== undefined) {
              try {
                const st = statSync(neighborFull);
                if (st.isFile() && st.size <= 64 * 1024) {
                  texts.set(file.path, readFileSync(neighborFull, "utf8"));
                }
              } catch {
                // fail open
              }
            }
          }
        }
      }
    }

    const result = resolveRefer({
      path: rel,
      fileText,
      line,
      symbol,
      readNeighbor: defaultTeachNeighbor(full),
      texts,
      witnesses,
    });

    if (result.definition !== null) {
      result.definition.text = redactSecretsAtBoundary(result.definition.text);
      if (result.definition.jsdoc !== undefined) {
        result.definition.jsdoc = redactSecretsAtBoundary(result.definition.jsdoc);
      }
    }
    for (const ref of result.references) {
      ref.text = redactSecretsAtBoundary(ref.text);
    }

    return sendJson(response, 200, result);
  }

  if (pathname === "/api/teach" && request.method === "POST") {
    const body = (await readBody(request)) as Record<string, unknown>;
    const rel = String(body.path ?? "");
    let start = Number(body.start ?? 0);
    let end = Number(body.end ?? 0);
    const full = confine(root, rel) ?? witnessed(rel);
    if (full === undefined) return forbid(response);

    const lines = existsSync(full) ? readFileSync(full, "utf8").split(/\r?\n/) : [];
    const snippet = lines.slice(Math.max(0, start - 1), end).join("\n");
    const { list } = records();

    let expanded: { start: number; end: number; why: string } | undefined;
    if (body.expand === 1 && start === end) {
      let rows: DiffRow[] | undefined;
      const commit = typeof body.commit === "string" ? body.commit : "";
      if (/^[0-9a-fA-F]{4,128}$/.test(commit)) {
        const resolved = resolveCommitDiff({ sha: commit, cwd: root });
        if (resolved !== undefined) {
          const parsedRows = parsePatch(resolved.diff);
          const byFile = splitRowsByFile(parsedRows);
          for (const [diffPath, fileRows] of byFile.entries()) {
            if (diffPath === rel || diffPath.endsWith("/" + rel) || rel.endsWith("/" + diffPath)) {
              rows = fileRows;
              break;
            }
          }
        }
      }
      const ctx = resolveContext({
        fileText: lines.join("\n"),
        line: start,
        ...(rows !== undefined ? { rows } : {}),
      });
      start = ctx.start;
      end = ctx.end;
      expanded = { start: ctx.start, end: ctx.end, why: ctx.why };
    }

    const hit = teachLookup(list, { path: rel, snippet, cwd: root });
    const ladder = buildLadder({
      file: rel,
      startLine: start,
      endLine: end,
      fileText: lines.join("\n"),
      readNeighbor: defaultTeachNeighbor(rel),
    });

    if (hit !== undefined) {
      const card = renderWitnessCard(hit, gapRungFor(hit, ladder));
      return sendJson(response, 200, expanded !== undefined ? { ...card, expanded } : card);
    }
    if (ladder.rungs.length > 0) {
      const card = renderLadderCard(rel, `${start}-${end}`, ladder);
      const payload = { ...card, rungs: renderLadderExpanded(ladder) };
      return sendJson(response, 200, expanded !== undefined ? { ...payload, expanded } : payload);
    }
    return sendJson(response, 200, null);
  }

  if (pathname === "/api/providers") {
    return sendJson(response, 200, await providerList());
  }

  if (pathname === "/api/provider") {
    // an endpoint the catalogue does not know returns nothing, so the page
    // offers no models rather than a wrong list
    const found = await providerFor(url.searchParams.get("endpoint") ?? "");
    return sendJson(response, 200, found ?? null);
  }

  if (pathname === "/api/settings") {
    if (request.method === "POST") {
      const patch = (await readBody(request)) as Record<string, unknown>;
      return sendJson(response, 200, publicSettings(writeSettings(patch)));
    }
    return sendJson(response, 200, publicSettings(readSettings()));
  }

  if (pathname === "/api/ask" && request.method === "POST") {
    const body = (await readBody(request)) as Record<string, unknown>;
    const { status, payload } = await ask(body, root);
    return sendJson(response, status, payload);
  }

  response.writeHead(404, baseHeaders("text/plain; charset=utf-8")).end("no");
}

export interface GuiHandle {
  port: number;
  token: string;
  url: string;
  close: () => Promise<void>;
}

/** Starts the surface. Resolves once bound, so the caller can print the URL. */
export function startGui(options: { port?: number; root?: string } = {}): Promise<GuiHandle> {
  const token = randomBytes(16).toString("hex");
  const root = resolve(options.root ?? process.cwd());
  const wanted = options.port ?? DEFAULT_GUI_PORT;
  let boundPort = wanted;
  void computeBundles().catch(() => {});

  const server = createServer((request, response) => {
    void (async () => {
      try {
        const addr = server.address();
        const port = typeof addr === "object" && addr !== null ? addr.port : boundPort;
        if (!hostAllowed(request.headers.host, port)) return forbid(response);
        const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
        const pathname = url.pathname;

        if (pathname.startsWith("/api/")) {
          // the shell and its assets load before any script can send a header,
          // so only the api is token-gated
          if (request.headers["x-rocky-token"] !== token) return forbid(response);
          return await handleApi(pathname, url, request, response, root);
        }
        if (pathname === "/" || pathname.startsWith("/assets/")) {
          return await serveAsset(pathname, response);
        }
        response.writeHead(404, baseHeaders("text/plain; charset=utf-8")).end("no");
      } catch {
        // one bad request never takes the server down with it
        if (!response.headersSent) sendJson(response, 500, { error: "rocky not hear that, question" });
        else response.end();
      }
    })();
  });

  return new Promise((done, fail) => {
    const bind = (port: number, retry: boolean): void => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        // the wanted port being busy is not a failure: take any free one
        if (retry && error.code === "EADDRINUSE") return bind(0, false);
        fail(error);
      });
      server.listen(port, "127.0.0.1", () => {
        const addr = server.address();
        boundPort = typeof addr === "object" && addr !== null ? addr.port : port;
        done({
          port: boundPort,
          token,
          url: `http://127.0.0.1:${boundPort}/#${token}`,
          close: () =>
            new Promise<void>((shut) => {
              if (typeof (server as any).closeAllConnections === "function") {
                (server as any).closeAllConnections();
              }
              server.close(() => shut());
            }),
        });
      });
    };
    bind(wanted, wanted !== 0);
  });
}
