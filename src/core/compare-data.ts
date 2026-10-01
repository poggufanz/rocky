import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { MemoryRecord } from "./memory-read.js";
import { redactSecretsAtBoundary } from "./redact.js";
import { resolveGitDiff, firstShaAfter } from "./git-diff.js";

export interface CompareRec {
  kind: string;
  ts: number;
  cwd: string;
  source: string;
  intent?: string;
  reason?: string;
  machine: boolean;
  summary?: string;
  head?: string;
  baseHead?: string;
  snapshot?: string;
  plus?: number;
  minus?: number;
  excerpt?: string;
}

export interface FileEntry {
  path: string;
  recs: CompareRec[];
  count: number;
  firstTs: number;
  lastTs: number;
}

/**
 * A heard-file entry must be a path, not a shell fragment. Agents sometimes
 * pass `--files "$(echo src/a.ts | tr / '/')"` through a shell that never
 * expands it; stored as-is, the dash lists a file that can never exist on
 * disk. Reject the characters that mark that kind of fragment -- `$` backtick
 * `()|<>\"` -- plus control characters. `'` stays: POSIX names may carry it.
 */
const SHELL_FRAGMENT = /[$`()|<>"]|[\u0000-\u001f\u007f-\u009f]/u;

export function plausibleFilePath(path: string): boolean {
  return path.trim().length > 0 && !SHELL_FRAGMENT.test(path);
}

export interface DiffRow {
  k: "@" | "h" | "+" | "-" | " " | "m" | "x";
  o?: number;
  n?: number;
  t: string;
}

export interface DiffResult {
  commit?: string;
  prior?: boolean;
  after?: boolean;
  stored?: boolean;
  rows: DiffRow[];
}

export function fileIndex(records: MemoryRecord[]): FileEntry[] {
  const filesMap = new Map<string, CompareRec[]>();

  const push = (filePath: string, rec: CompareRec): void => {
    if (!plausibleFilePath(filePath)) return;
    const key = filePath.replace(/\\/g, "/");
    const existing = filesMap.get(key);
    if (existing) {
      existing.push(rec);
    } else {
      filesMap.set(key, [rec]);
    }
  };

  const anchorPath = (p: string, cwd: string): string => {
    const norm = p.replace(/\\/g, "/");
    if (/^[a-zA-Z]:\//.test(norm) || norm.startsWith("/")) {
      return norm;
    }
    if (cwd) {
      const cleanCwd = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
      const cleanP = norm.replace(/^\.?\//, "");
      return `${cleanCwd}/${cleanP}`;
    }
    return norm;
  };

  for (const r of records) {
    const raw = r as unknown as Record<string, unknown>;
    const intentText =
      typeof raw.intent === "string"
        ? raw.intent
        : typeof raw.intent === "object" && raw.intent !== null
        ? (raw.intent as { text?: string }).text
        : undefined;

    const isMachine = typeof intentText === "string" && /<task-notification>|<task-id>/.test(intentText);
    const summary =
      isMachine && typeof intentText === "string"
        ? intentText.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim() ?? "agent notification"
        : undefined;

    const reasonText =
      (typeof raw.rationale === "object" && raw.rationale !== null ? (raw.rationale as { text?: string }).text : undefined) ??
      (typeof raw.rationale === "string" && raw.rationale.length > 0 ? raw.rationale : undefined) ??
      (typeof raw.code === "string" && raw.code.length > 0 ? raw.code : undefined) ??
      (typeof raw.business === "string" && raw.business.length > 0 ? raw.business : undefined) ??
      (typeof raw.excerpt === "string" ? raw.excerpt : undefined) ??
      (typeof raw.snippet === "string" && raw.snippet.length > 0 ? raw.snippet : undefined) ??
      (typeof raw.note === "string" ? raw.note : undefined) ??
      (typeof raw.subject === "string" ? raw.subject : undefined) ??
      (typeof raw.invariant === "string" ? raw.invariant : undefined);

    const source = String(raw.source ?? raw.agent ?? "");
    const head = (raw.mechanism as { head?: string } | undefined)?.head;
    const gitAnchor = raw.git as { base?: string; snapshot?: string } | undefined;
    const baseHead = typeof gitAnchor?.base === "string" ? gitAnchor.base : undefined;
    const snapshot = typeof gitAnchor?.snapshot === "string" ? gitAnchor.snapshot : undefined;
    const cwd = String(raw.cwd ?? "");

    const baseRec: CompareRec = {
      kind: r.kind || "unknown",
      ts: r.ts ?? 0,
      cwd,
      source,
      ...(intentText !== undefined ? { intent: redactSecretsAtBoundary(intentText) } : {}),
      ...(reasonText !== undefined ? { reason: redactSecretsAtBoundary(reasonText) } : {}),
      machine: isMachine,
      ...(summary !== undefined ? { summary: redactSecretsAtBoundary(summary) } : {}),
      ...(typeof head === "string" ? { head } : {}),
      ...(baseHead === undefined ? {} : { baseHead }),
      ...(snapshot === undefined ? {} : { snapshot }),
    };

    const seenPathsInRecord = new Set<string>();

    const addFile = (p: string | undefined, extra: { plus?: number; minus?: number; excerpt?: string } = {}): void => {
      if (!p || typeof p !== "string") return;
      const full = anchorPath(p, cwd);
      if (seenPathsInRecord.has(full)) return;
      seenPathsInRecord.add(full);
      push(full, {
        ...baseRec,
        ...(extra.plus !== undefined ? { plus: extra.plus } : {}),
        ...(extra.minus !== undefined ? { minus: extra.minus } : {}),
        ...(extra.excerpt !== undefined ? { excerpt: redactSecretsAtBoundary(extra.excerpt) } : {}),
      });
    };

    if (typeof raw.file === "string") {
      addFile(raw.file);
    }

    const mechFiles = (raw.mechanism as { files?: Array<{ path?: string; plusMinus?: [number, number]; excerpt?: string } | string> } | undefined)?.files;
    if (Array.isArray(mechFiles)) {
      for (const f of mechFiles) {
        const p = typeof f === "string" ? f : f?.path;
        const plusMinus = typeof f === "object" && f !== null && Array.isArray(f.plusMinus) ? f.plusMinus : undefined;
        const excerpt = typeof f === "object" && f !== null && typeof f.excerpt === "string" ? f.excerpt : undefined;
        addFile(p, {
          plus: plusMinus ? plusMinus[0] : undefined,
          minus: plusMinus ? plusMinus[1] : undefined,
          excerpt,
        });
      }
    }

    const filesArray = raw.files;
    if (Array.isArray(filesArray)) {
      for (const f of filesArray) {
        const p = typeof f === "string" ? f : (f as { path?: string })?.path;
        addFile(p);
      }
    }

    if (typeof raw.path === "string") {
      addFile(raw.path);
    }
  }

  const entries: FileEntry[] = [];
  for (const [path, recs] of filesMap.entries()) {
    recs.sort((a, b) => b.ts - a.ts);
    entries.push({
      path,
      recs,
      count: recs.length,
      firstTs: recs[recs.length - 1]?.ts ?? 0,
      lastTs: recs[0]?.ts ?? 0,
    });
  }

  entries.sort((a, b) => b.count - a.count || b.lastTs - a.lastTs || a.path.localeCompare(b.path));
  return entries;
}

export function gitRootFor(absPath: string, exists: (p: string) => boolean): string | undefined {
  let p = absPath.replace(/\\/g, "/");
  const lastSlash = p.lastIndexOf("/");
  if (lastSlash === -1) return undefined;
  let dir = lastSlash === 0 ? "/" : p.slice(0, lastSlash);

  // Skip nonexistent child directories first
  while (dir && dir !== "/" && !/^[a-zA-Z]:\/?$/.test(dir) && !exists(dir)) {
    const idx = dir.lastIndexOf("/");
    if (idx <= 0) {
      dir = idx === 0 ? "/" : "";
      break;
    }
    dir = dir.slice(0, idx);
  }

  let cur = dir;
  while (cur && cur.length > 0) {
    const gitDir = cur === "/" ? "/.git" : `${cur}/.git`;
    if (exists(gitDir)) return cur;
    if (cur === "/" || /^[a-zA-Z]:\/?$/.test(cur)) break;
    const idx = cur.lastIndexOf("/");
    if (idx <= 0) {
      if (idx === 0) {
        cur = "/";
        if (exists("/.git")) return "/";
      }
      break;
    }
    cur = cur.slice(0, idx);
  }
  return undefined;
}

const lsFilesCache = new Map<string, Map<string, string>>();

export function clearTrueCaseCache(): void {
  lsFilesCache.clear();
}

export function trueCaseRel(root: string, rel: string, lsFiles: (root: string) => string[]): string {
  const normRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  let map = lsFilesCache.get(normRoot);
  if (!map) {
    map = new Map<string, string>();
    try {
      const files = lsFiles(normRoot);
      for (const f of files) {
        if (f) {
          const normF = f.replace(/\\/g, "/");
          map.set(normF.toLowerCase(), normF);
        }
      }
    } catch {
      // fail open
    }
    lsFilesCache.set(normRoot, map);
  }
  const normRel = rel.replace(/\\/g, "/");
  return map.get(normRel.toLowerCase()) ?? rel;
}

export function parsePatch(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let o = 0;
  let n = 0;
  for (const rawLine of String(patch).split(/\r?\n/)) {
    if (rawLine.startsWith("@@")) {
      const m = rawLine.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        o = Number(m[1]);
        n = Number(m[2]);
      }
      rows.push({ k: "@", t: rawLine });
      continue;
    }
    if (/^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(rawLine)) {
      rows.push({ k: "h", t: rawLine });
      continue;
    }
    if (rawLine.startsWith("\\")) continue;
    if (rawLine.startsWith("+")) {
      rows.push({ k: "+", n: n++, t: rawLine.slice(1) });
      continue;
    }
    if (rawLine.startsWith("-")) {
      rows.push({ k: "-", o: o++, t: rawLine.slice(1) });
      continue;
    }
    rows.push({
      k: " ",
      o: o++,
      n: n++,
      t: rawLine.startsWith(" ") ? rawLine.slice(1) : rawLine,
    });
  }
  while (rows.length > 0 && rows[rows.length - 1].k === " " && !rows[rows.length - 1].t) {
    rows.pop();
  }
  return rows;
}

/** Forward-attribution window for prospective moments; mirrors LINK_WINDOW_MS. */
export const AFTER_CAP_MS = 8 * 60 * 60 * 1000;

export function diffFor(
  filePath: string,
  rec: CompareRec,
  io: {
    exists(p: string): boolean;
    lsFiles(root: string): string[];
    resolve(opts: { ts: number; head?: string; file: string; cwd: string }): { commit?: string; diff: string } | undefined;
    lastShaBefore(root: string, rel: string, tsIso: string): string;
    firstShaAfter(root: string, rel: string, opts: { base?: string; ts: number; capMs: number }): string;
  },
): DiffResult {
  const buildMsgRows = (messages: string[]): DiffRow[] => {
    const rows: DiffRow[] = messages.map((t) => ({ k: "m" as const, t }));
    if (rec.excerpt) {
      rows.push(
        { k: "m", t: "" },
        { k: "m", t: "excerpt rocky kept:" },
        ...String(rec.excerpt)
          .split(/\r?\n/)
          .slice(0, 20)
          .map((t) => ({ k: "x" as const, t: redactSecretsAtBoundary(t) })),
      );
    }
    return rows;
  };

  try {
    if (typeof rec.snapshot === "string" && rec.snapshot.trim().length > 0) {
      const shortBase = typeof rec.baseHead === "string" && /^[0-9a-fA-F]{4,128}$/.test(rec.baseHead)
        ? rec.baseHead.slice(0, 7)
        : undefined;
      return {
        ...(shortBase === undefined ? {} : { commit: shortBase }),
        stored: true,
        rows: parsePatch(rec.snapshot),
      };
    }

    let abs = filePath.replace(/\\/g, "/");
    if (/[a-zA-Z]:[^/]/.test(abs)) {
      return {
        rows: buildMsgRows(["(malformed file path)"]),
      };
    }
    if (!/^[a-zA-Z]:\//.test(abs) && !abs.startsWith("/") && rec.cwd) {
      abs = rec.cwd.replace(/\\/g, "/").replace(/\/+$/, "") + "/" + abs;
    }

    const root = gitRootFor(abs, io.exists);
    if (!root) {
      return {
        rows: buildMsgRows(["(no .git above this file —", " rocky cannot scope a diff to it)"]),
      };
    }

    const relPath = root.endsWith("/") ? abs.slice(root.length) : abs.slice(root.length + 1);
    if (/^[a-zA-Z]:/.test(relPath) || relPath.startsWith("../")) {
      return {
        rows: buildMsgRows(["(file outside git repository)"]),
      };
    }
    const rel = trueCaseRel(root, relPath, io.lsFiles);

    const res = io.resolve({ ts: rec.ts, head: rec.head, file: rel, cwd: root });
    if (res && res.diff) {
      return { commit: res.commit, rows: parsePatch(res.diff) };
    }
    if (rec.head && /^[0-9a-fA-F]{4,128}$/.test(rec.head) && rec.kind !== "rationale") {
      return {
        rows: buildMsgRows(["(no change to this file in this commit)"]),
      };
    }

    // Prospective lookup shared by both branches below: the first commit
    // touching this file at or after the moment. Bounded and labeled, so a
    // miss simply yields undefined and the caller keeps its own precedence.
    const tryAfter = (): DiffResult | undefined => {
      let child = "";
      try {
        child = io.firstShaAfter(root, rel, { base: rec.head ?? rec.baseHead, ts: rec.ts, capMs: AFTER_CAP_MS }) || "";
      } catch {
        child = "";
      }
      const after = child ? io.resolve({ ts: rec.ts, head: child, file: rel, cwd: root }) : undefined;
      if (after && after.diff) {
        return { commit: after.commit, after: true, rows: parsePatch(after.diff) };
      }
      return undefined;
    };

    if (rec.kind === "rationale") {
      const after = tryAfter();
      if (after) return after;
    }

    const until = new Date(rec.ts).toISOString();
    let sha = "";
    try {
      sha = io.lastShaBefore(root, rel, until) || "";
    } catch {
      sha = "";
    }

    const prior = sha ? io.resolve({ ts: rec.ts, head: sha, file: rel, cwd: root }) : undefined;
    if (prior && prior.diff) {
      return { commit: prior.commit, prior: true, rows: parsePatch(prior.diff) };
    }

    // A non-rationale moment about just-written code (e.g. an explain recorded
    // mid-session for a file committed later) finds nothing behind it; one
    // bounded look ahead heals exactly that case and nothing else.
    if (rec.kind !== "rationale") {
      const after = tryAfter();
      if (after) return after;
    }

    return {
      rows: buildMsgRows(["(no change to this file before this moment)"]),
    };
  } catch {
    return {
      rows: buildMsgRows(["(git diff unavailable)"]),
    };
  }
}

const resolveCache = new Map<string, ReturnType<typeof resolveGitDiff>>();
const shaBeforeCache = new Map<string, string>();
const shaAfterCache = new Map<string, string>();

export const defaultDiffIo = {
  exists: (p: string) => existsSync(p),
  lsFiles: (root: string) => {
    try {
      return execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/);
    } catch {
      return [];
    }
  },
  resolve: (opts: { ts: number; head?: string; file: string; cwd: string }) => {
    const key = opts.head ? `${opts.cwd}::${opts.file}::${opts.head}` : `${opts.cwd}::${opts.file}::${opts.ts}`;
    if (resolveCache.has(key)) return resolveCache.get(key);
    const res = resolveGitDiff(opts);
    resolveCache.set(key, res);
    return res;
  },
  lastShaBefore: (root: string, rel: string, tsIso: string) => {
    const key = `${root}::${rel}::${tsIso}`;
    if (shaBeforeCache.has(key)) return shaBeforeCache.get(key)!;
    try {
      const res = execFileSync("git", ["-C", root, "log", "-n", "1", "--format=%H", `--until=${tsIso}`, "--", rel], {
        encoding: "utf8",
        timeout: 4000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      shaBeforeCache.set(key, res);
      return res;
    } catch {
      shaBeforeCache.set(key, "");
      return "";
    }
  },
  firstShaAfter: (root: string, rel: string, opts: { base?: string; ts: number; capMs: number }) => {
    const key = `${root}::${rel}::${opts.base ?? opts.ts}`;
    if (shaAfterCache.has(key)) return shaAfterCache.get(key)!;
    const res = firstShaAfter(root, rel, opts);
    shaAfterCache.set(key, res);
    return res;
  },
};

/**
 * Line spans one record's diff touched, on both the old and the new side.
 * `pad` widens each span because line numbers drift between commits — two
 * edits to the same function can sit a few lines apart in different diffs.
 * ponytail: hunk headers only, no content matching; if drift ever exceeds the
 * pad, move to blame-anchored spans.
 */
export function touchedSpans(rows: DiffRow[], pad = 3): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const row of rows) {
    if (row.k !== "@") continue;
    const m = row.t.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!m) continue;
    const o = Number(m[1]);
    const oLen = m[2] === undefined ? 1 : Number(m[2]);
    const n = Number(m[3]);
    const nLen = m[4] === undefined ? 1 : Number(m[4]);
    if (oLen > 0) spans.push([Math.max(1, o - pad), o + oLen - 1 + pad]);
    if (nLen > 0) spans.push([Math.max(1, n - pad), n + nLen - 1 + pad]);
  }
  return spans;
}

export function spansOverlap(a: Array<[number, number]>, b: Array<[number, number]>): boolean {
  for (const [as, ae] of a) {
    for (const [bs, be] of b) {
      if (as <= be && bs <= ae) return true;
    }
  }
  return false;
}

const diffCache = new Map<string, DiffResult>();

export function clearDiffCache(): void {
  diffCache.clear();
  resolveCache.clear();
  shaBeforeCache.clear();
  shaAfterCache.clear();
}

export function getCachedDiff(
  filePath: string,
  rec: CompareRec,
  io: {
    exists(p: string): boolean;
    lsFiles(root: string): string[];
    resolve(opts: { ts: number; head?: string; file: string; cwd: string }): { commit?: string; diff: string } | undefined;
    lastShaBefore(root: string, rel: string, tsIso: string): string;
    firstShaAfter(root: string, rel: string, opts: { base?: string; ts: number; capMs: number }): string;
  } = defaultDiffIo,
): DiffResult {
  const key = rec.head ? `${filePath}@head:${rec.head}` : `${filePath}@${rec.ts}`;
  let cached = diffCache.get(key);
  if (!cached) {
    cached = diffFor(filePath, rec, io);
    diffCache.set(key, cached);
  }
  return cached;
}

/**
 * Strict-compare rule: same file is not enough, both moments must touch
 * overlapping lines. Fails open when rocky holds no diff for a side — he never
 * hides a record he cannot judge.
 */
export function lineOverlapPredicate(
  filePath: string,
  io: Parameters<typeof getCachedDiff>[2] = defaultDiffIo,
): (a: CompareRec, b: CompareRec) => boolean {
  return (a, b) => {
    const sa = touchedSpans(getCachedDiff(filePath, a, io).rows);
    if (sa.length === 0) return true;
    const sb = touchedSpans(getCachedDiff(filePath, b, io).rows);
    if (sb.length === 0) return true;
    return spansOverlap(sa, sb);
  };
}

export interface WitnessMoment {
  id: string;
  diff?: { commit?: string; stored?: boolean; after?: boolean; prior?: boolean; rows: DiffRow[] } | undefined;
}

export type ChangeEpistemic = "recorded" | "committed" | "prior" | "after" | "uncommitted";

export interface ChangeGroup<T> {
  key: string;
  commit?: string;
  epistemic: ChangeEpistemic;
  diff: DiffResult;
  witnesses: T[];
}

/** Placeholder/message rows carry no evidence; only real diff rows do. */
export function hasRealRows(rows: DiffRow[]): boolean {
  return rows.some((r) => r.k === "@" || r.k === "+" || r.k === "-");
}

/**
 * Group moments by the unique change they witness so one diff is never
 * rendered twice. Moments are evidence-poor annotations; the change owns
 * the single diff block. Order is first-witness stable. Never throws:
 * anything unattributable lands in `unattributed` with its reason intact.
 */
export function groupMomentsByChange<T extends WitnessMoment>(
  moments: T[],
): { changes: ChangeGroup<T>[]; unattributed: T[] } {
  const changes: ChangeGroup<T>[] = [];
  const byKey = new Map<string, ChangeGroup<T>>();
  const unattributed: T[] = [];
  const snapshotText = (rows: DiffRow[]): string => rows.map((r) => `${r.k}${r.o ?? ""}:${r.n ?? ""}:${r.t}`).join("\n");
  for (const m of moments) {
    const d = m.diff;
    if (!d || !hasRealRows(d.rows)) {
      unattributed.push(m);
      continue;
    }
    if (d.commit === "uncommitted") {
      const key = "uncommitted";
      let g = byKey.get(key);
      if (!g) {
        g = { key, commit: "uncommitted", epistemic: "uncommitted", diff: d as DiffResult, witnesses: [] };
        byKey.set(key, g);
        changes.push(g);
      }
      g.witnesses.push(m);
      continue;
    }
    if (typeof d.commit === "string" && d.commit.length > 0) {
      const epistemic: ChangeEpistemic = d.stored ? "recorded" : d.after ? "after" : d.prior ? "prior" : "committed";
      const key = `${epistemic}:${d.commit}`;
      let g = byKey.get(key);
      if (!g) {
        g = { key, commit: d.commit, epistemic, diff: d as DiffResult, witnesses: [] };
        byKey.set(key, g);
        changes.push(g);
      }
      g.witnesses.push(m);
      continue;
    }
    const key = `recorded-snapshot:\n${snapshotText(d.rows)}`;
    let g = byKey.get(key);
    if (!g) {
      g = { key, epistemic: "recorded", diff: d as DiffResult, witnesses: [] };
      byKey.set(key, g);
      changes.push(g);
    }
    g.witnesses.push(m);
  }
  return { changes, unattributed };
}



