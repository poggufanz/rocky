import type { CompareRec, DiffResult, DiffRow, ChangeEpistemic } from "./compare-data.js";
import { touchedSpans, hasRealRows } from "./compare-data.js";

export interface BundleInput {
  path: string;
  repo: string;
  rec: CompareRec;
  diff: DiffResult;
}

export interface BundleFile {
  path: string;
  plus?: number;
  minus?: number;
  spans: Array<[number, number]>;
}

export interface BundleSummary {
  key: string;
  commit?: string;
  epistemic: ChangeEpistemic;
  repo: string;
  ts: number;
  files: BundleFile[];
  witnessCount: number;
  truncated: boolean;
}

export const BUNDLE_MAX_FILES = 50;

const snapshotText = (rows: DiffRow[]): string =>
  rows.map((r) => `${r.k}${r.o ?? ""}:${r.n ?? ""}:${r.t}`).join("\n");

export function bundleGroups(inputs: readonly BundleInput[]): {
  bundles: BundleSummary[];
  unattributed: BundleInput[];
} {
  const bundles: BundleSummary[] = [];
  const byKey = new Map<string, BundleSummary>();
  const unattributed: BundleInput[] = [];

  for (const input of inputs) {
    const d = input.diff;
    if (!d || !hasRealRows(d.rows)) {
      unattributed.push(input);
      continue;
    }

    let key: string;
    let commit: string | undefined;
    let epistemic: ChangeEpistemic;

    if (d.commit === "uncommitted") {
      key = "uncommitted";
      commit = "uncommitted";
      epistemic = "uncommitted";
    } else if (typeof d.commit === "string" && d.commit.length > 0) {
      epistemic = d.stored ? "recorded" : d.after ? "after" : d.prior ? "prior" : "committed";
      commit = d.commit;
      key = `${epistemic}:${commit}`;
    } else {
      key = `recorded-snapshot:\n${snapshotText(d.rows)}`;
      epistemic = "recorded";
      commit = undefined;
    }

    let bundle = byKey.get(key);
    if (!bundle) {
      bundle = {
        key,
        ...(commit !== undefined ? { commit } : {}),
        epistemic,
        repo: input.repo ?? "",
        ts: input.rec.ts ?? 0,
        files: [],
        witnessCount: 0,
        truncated: false,
      };
      byKey.set(key, bundle);
      bundles.push(bundle);
    }

    if ((input.rec.ts ?? 0) > bundle.ts) {
      bundle.ts = input.rec.ts;
    }
    bundle.witnessCount++;

    const existingFile = bundle.files.find((f) => f.path === input.path);
    if (existingFile) {
      const newSpans = touchedSpans(d.rows);
      for (const [ns, ne] of newSpans) {
        if (!existingFile.spans.some(([es, ee]) => es === ns && ee === ne)) {
          existingFile.spans.push([ns, ne]);
        }
      }
    } else {
      if (bundle.files.length < BUNDLE_MAX_FILES) {
        let rowPlus = 0;
        let rowMinus = 0;
        let counted = false;
        for (const r of d.rows) {
          if (r.k === "+") {
            rowPlus++;
            counted = true;
          } else if (r.k === "-") {
            rowMinus++;
            counted = true;
          }
        }
        const plus = input.rec.plus !== undefined ? input.rec.plus : counted ? rowPlus : undefined;
        const minus = input.rec.minus !== undefined ? input.rec.minus : counted ? rowMinus : undefined;

        bundle.files.push({
          path: input.path,
          ...(plus !== undefined ? { plus } : {}),
          ...(minus !== undefined ? { minus } : {}),
          spans: touchedSpans(d.rows),
        });
      } else {
        bundle.truncated = true;
      }
    }
  }

  return { bundles, unattributed };
}

export function splitRowsByFile(rows: DiffRow[]): Map<string, DiffRow[]> {
  const byFile = new Map<string, DiffRow[]>();
  let currentFile = "(unknown)";

  for (const row of rows) {
    if (row.k === "h") {
      const m =
        row.t.match(/^diff --git a\/(.*?) b\/\1\s*$/) ??
        row.t.match(/^diff --git "a\/(.*?)" "b\/\1"\s*$/) ??
        row.t.match(/^diff --git a\/.+? b\/(.+?)\s*$/);
      if (m && m[1]) {
        currentFile = m[1];
      }
    }
    let list = byFile.get(currentFile);
    if (!list) {
      list = [];
      byFile.set(currentFile, list);
    }
    list.push(row);
  }

  return byFile;
}
