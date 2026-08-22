import type { MemoryRecord } from "../../../core/memory-read.js";
import { redactSecretsAtBoundary } from "../../../core/redact.js";

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

export interface DiffRow {
  k: "@" | "h" | "+" | "-" | " " | "m" | "x";
  o?: number;
  n?: number;
  t: string;
}

export interface DiffResult {
  commit?: string;
  prior?: boolean;
  rows: DiffRow[];
}

export function fileIndex(records: MemoryRecord[]): FileEntry[] {
  const filesMap = new Map<string, CompareRec[]>();

  const push = (filePath: string, rec: CompareRec): void => {
    if (!filePath) return;
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
      (typeof raw.rationale === "string" ? raw.rationale : undefined) ??
      (typeof raw.excerpt === "string" ? raw.excerpt : undefined) ??
      (typeof raw.note === "string" ? raw.note : undefined) ??
      (typeof raw.subject === "string" ? raw.subject : undefined) ??
      (typeof raw.invariant === "string" ? raw.invariant : undefined);

    const source = String(raw.source ?? raw.agent ?? "");
    const head = (raw.mechanism as { head?: string } | undefined)?.head;
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

export function diffFor(
  filePath: string,
  rec: CompareRec,
  io: {
    exists(p: string): boolean;
    lsFiles(root: string): string[];
    resolve(opts: { ts: number; head?: string; file: string; cwd: string }): { commit: string; diff: string } | undefined;
    lastShaBefore(root: string, rel: string, tsIso: string): string;
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
    let abs = filePath.replace(/\\/g, "/");
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
    const rel = trueCaseRel(root, relPath, io.lsFiles);

    const res = io.resolve({ ts: rec.ts, head: rec.head, file: rel, cwd: root });
    if (res && res.diff) {
      return { commit: res.commit, rows: parsePatch(res.diff) };
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

    return {
      rows: buildMsgRows(["(no change to this file before this moment)"]),
    };
  } catch {
    return {
      rows: buildMsgRows(["(git diff unavailable)"]),
    };
  }
}
