import type { TeachHit } from "./teach.js";
import type { LadderResult, Rung } from "./teach-ladder.js";

export interface TeachCard {
  header: string;
  lines: readonly string[];
  evidence: string;
  expandable: boolean;
}

const WITNESS_HEADER = "rocky heard this. agent say why, rocky remember";
const LADDER_HEADER = "rocky not hear this. assembled from evidence, not witnessed";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export function ageLabel(ts: number, now: number): string {
  const delta = Math.max(0, now - ts);
  if (delta >= DAY_MS) return `${Math.floor(delta / DAY_MS)}d ago`;
  if (delta >= HOUR_MS) return `${Math.floor(delta / HOUR_MS)}h ago`;
  return `${Math.floor(delta / MINUTE_MS)}m ago`;
}

export function renderWitnessCard(hit: TeachHit, gapRung?: Rung): TeachCard {
  const lines: string[] = [
    `code: ${hit.record.code}`,
    `business: ${hit.record.business}`,
  ];
  if (gapRung !== undefined) {
    lines.push(`form: ${gapRung.finding} · ${gapRung.source}`);
  }
  return {
    header: WITNESS_HEADER,
    lines,
    evidence: `source: ${hit.record.source} · ${ageLabel(hit.record.ts, Date.now())}`,
    expandable: false,
  };
}

export function renderLadderCard(file: string, label: string, ladder: LadderResult): TeachCard {
  const lines: string[] = [`${file} · ${label}`];
  if (ladder.rungs.length > 0) {
    lines.push(`reason: ${ladder.rungs.map((rung) => rung.finding).join(". ")}`);
  }
  return {
    header: LADDER_HEADER,
    lines,
    evidence: `evidence: ${evidenceSources(ladder.rungs).join(" · ")}`,
    expandable: ladder.rungs.length > 0,
  };
}

export function renderLadderExpanded(ladder: LadderResult): readonly string[] {
  return ladder.rungs.map((rung, index) => `why ${index + 1}  ${rung.finding} · ${rung.source}`);
}

function evidenceSources(rungs: readonly Rung[]): string[] {
  const seen = new Set<string>();
  const sources: string[] = [];
  for (const rung of rungs) {
    const label = evidenceSource(rung);
    if (seen.has(label)) continue;
    seen.add(label);
    sources.push(label);
  }
  return sources;
}

function evidenceSource(rung: Rung): string {
  if (rung.source === "comment") {
    const quoted = /"([^"]*)"/.exec(rung.finding);
    if (quoted !== null) return `comment "${quoted[1] ?? ""}"`;
  }
  return rung.source;
}
