import type { MemoryRecord } from "../../../core/memory-read.js";
import { redactSecretsAtBoundary } from "../../../core/redact.js";
import { elapsed } from "../../rocky.js";

export interface HomeData {
  total: number;
  coverageLine: string;
  byKind: Array<{ kind: string; count: number }>;
  day: { heard: number; failures: number; fixes: number; whys: number };
  topFiles: Array<{ name: string; count: number }>;
  recent: Array<{ label: string; agoText: string; kind: string; machine: boolean }>;
}

export function adaptHit(
  record: MemoryRecord,
  now: number,
): { label: string; agoText: string; kind: string; machine: boolean } {
  const ts = record.ts ?? 0;
  const span = elapsed(Math.max(0, now - ts));
  const agoText = span === "just now" ? span : `${span} ago`;

  const raw = record as unknown as Record<string, unknown>;
  const intentText =
    typeof raw.intent === "string"
      ? raw.intent
      : typeof raw.intent === "object" && raw.intent !== null
      ? (raw.intent as { text?: string }).text
      : undefined;

  const isMachine = typeof intentText === "string" && /<task-notification>|<task-id>/.test(intentText);
  let rawLabel = "";

  if (isMachine && typeof intentText === "string") {
    const summaryMatch = intentText.match(/<summary>([\s\S]*?)<\/summary>/);
    rawLabel = summaryMatch ? summaryMatch[1].trim() : "agent notification";
  } else {
    const reasonText =
      (typeof raw.rationale === "object" && raw.rationale !== null ? (raw.rationale as { text?: string }).text : undefined) ??
      (typeof raw.rationale === "string" ? raw.rationale : undefined) ??
      (typeof raw.excerpt === "string" ? raw.excerpt : undefined) ??
      (typeof raw.note === "string" ? raw.note : undefined) ??
      (typeof raw.subject === "string" ? raw.subject : undefined) ??
      (typeof raw.invariant === "string" ? raw.invariant : undefined) ??
      (typeof raw.alias === "string" ? `${raw.alias} -> ${raw.concept}` : undefined);

    const candidate =
      (typeof raw.cmd === "string" && raw.cmd !== "" ? raw.cmd : undefined) ??
      (typeof intentText === "string" && intentText !== "" ? intentText : undefined) ??
      (typeof reasonText === "string" && reasonText !== "" ? reasonText : undefined) ??
      record.kind;

    rawLabel = String(candidate);
  }

  const label = redactSecretsAtBoundary(rawLabel.replace(/\s+/g, " ").trim());
  return {
    label,
    agoText,
    kind: record.kind,
    machine: isMachine,
  };
}

export function deriveHome(
  records: MemoryRecord[],
  coverageReason: string | undefined,
  now: number,
): HomeData {
  const total = records.length;
  const coverageLine = coverageReason ? `coverage partial (${coverageReason})` : "coverage full";

  // Counts by kind
  const kindCounts = new Map<string, number>();
  for (const r of records) {
    const k = r.kind || "unknown";
    kindCounts.set(k, (kindCounts.get(k) ?? 0) + 1);
  }
  const byKind = [...kindCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, count]) => ({ kind, count }));

  // 24-hour activity
  const dayWindowMs = 24 * 3600 * 1000;
  const dayRecords = records.filter((r) => {
    const ts = r.ts ?? 0;
    return typeof ts === "number" && now - ts < dayWindowMs && now - ts >= 0;
  });

  const heard = dayRecords.length;
  const failures = dayRecords.filter((r) => r.kind === "failure").length;
  const fixes = dayRecords.filter((r) => r.kind === "fix" || r.kind === "association").length;
  const whys = dayRecords.filter((r) => {
    if (r.kind === "triple" || r.kind === "rationale" || r.kind === "note") return true;
    if (typeof (r as any).rationale === "object" && (r as any).rationale !== null && (r as any).rationale.text) return true;
    return false;
  }).length;
  const day = { heard, failures, fixes, whys };

  // Top files from mechanism.files
  const fileCounts = new Map<string, number>();
  for (const r of records) {
    const files = (r as any).mechanism?.files;
    if (Array.isArray(files)) {
      for (const f of files) {
        const path = typeof f === "string" ? f : f?.path;
        if (typeof path === "string" && path.length > 0) {
          const basename = path.replace(/\\/g, "/").split("/").pop();
          if (basename) {
            fileCounts.set(basename, (fileCounts.get(basename) ?? 0) + 1);
          }
        }
      }
    }
  }
  const topFiles = [...fileCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  // Recent 8 records
  const sorted = [...records].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  const recent = sorted.slice(0, 8).map((r) => adaptHit(r, now));

  return {
    total,
    coverageLine,
    byKind,
    day,
    topFiles,
    recent,
  };
}
