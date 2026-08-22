import type { Card } from "./card.js";
import type { Command } from "../surface/registry.js";
import type { RunOutcome } from "../surface/runcmd.js";
import type { ThemeToken } from "../theme.js";

export interface EvidenceHit {
  label: string;
  agoText: string;
  source: string;
  machine: boolean;
}

export function buildRecall(query: string, hits: EvidenceHit[]): Card {
  if (hits.length === 0) {
    return {
      kind: "recall",
      accent: "muted",
      subject: query,
      meta: "nothing",
      facts: [query, "nothing"],
      lines: [{ text: "rocky hears nothing like that. memory not grow yet, question", token: "muted" }],
    };
  }
  const facts = [query, `${hits.length} hits`];
  const lines: Card["lines"] = [];
  for (const h of hits) {
    facts.push(h.agoText, h.source);
    lines.push({ text: h.label, token: h.machine ? "muted" : "text" });
    lines.push({ text: `${h.agoText} · ${h.source}`, token: "muted", indent: 2 });
  }
  return { kind: "recall", accent: "accent", subject: query, meta: `${hits.length} hits`, facts, lines };
}

export function buildWhy(query: string, reasons: Array<{ text: string; source: string; agoText: string }>): Card {
  if (reasons.length === 0) {
    return {
      kind: "why",
      accent: "muted",
      subject: query,
      meta: "no why",
      facts: [query, "no why"],
      lines: [{ text: "rocky not know why. no rationale heard for this one.", token: "muted" }],
    };
  }
  const facts = [query, `heard ${reasons.length}`];
  const lines: Card["lines"] = [];
  for (const r of reasons) {
    facts.push(r.text, r.agoText, r.source);
    lines.push({ text: `"${r.text}"`, token: "text" });
    lines.push({ text: `${r.agoText} · ${r.source}`, token: "muted", indent: 2 });
  }
  return { kind: "why", accent: "why", subject: query, meta: `heard ${reasons.length}`, facts, lines };
}

export function buildSessions(rows: Array<{ index: number; cwdTail: string; count: number; endedAgo: string }>): Card {
  if (rows.length === 0) {
    return {
      kind: "sessions",
      accent: "muted",
      subject: "derived at read time",
      meta: "0 shown",
      facts: ["derived at read time", "0 shown"],
      lines: [{ text: "rocky hears no sessions in memory yet.", token: "muted" }],
    };
  }
  const facts = ["derived at read time", `${rows.length} shown`];
  const lines: Card["lines"] = [];
  for (const r of rows) {
    facts.push(r.cwdTail, `${r.count} records`, r.endedAgo);
    lines.push({ text: `${r.index}  ${r.cwdTail}`, token: "text" });
    lines.push({ text: `${r.count} records · ended ${r.endedAgo}`, token: "muted", indent: 3 });
  }
  return {
    kind: "sessions",
    accent: "accent",
    subject: "derived at read time",
    meta: `${rows.length} shown`,
    facts,
    lines,
  };
}

export function buildStats(byKind: Array<{ kind: string; count: number }>, total: number, oldestAgo: string): Card {
  const max = Math.max(...byKind.map((b) => b.count), 1);
  const facts = [`${total} records`, oldestAgo];
  const lines: Card["lines"] = [];
  for (const b of byKind) {
    facts.push(b.kind, `${b.count}`);
    const bar = "█".repeat(Math.max(1, Math.round((b.count / max) * 26)));
    const token: ThemeToken =
      b.kind === "failure" ? "err" :
      b.kind === "fix" || b.kind === "association" ? "ok" :
      b.kind === "guard" || b.kind === "invariant_touch" ? "guard" : "why";
    lines.push({
      text: `${b.kind.padEnd(16)}${String(b.count).padStart(4)}  ${bar}`,
      token,
    });
  }
  return {
    kind: "stats",
    accent: "accent",
    subject: `${total} records`,
    meta: oldestAgo ? `oldest ${oldestAgo}` : "",
    facts,
    lines,
  };
}

export function buildBrief(
  counts: { heard: number; failures: number; fixes: number; whys: number },
  recent: EvidenceHit[],
): Card {
  const facts = [
    "since 24h",
    `${counts.heard} records`,
    `${counts.failures} failure`,
    `${counts.fixes} fix`,
    `${counts.whys} why`,
  ];
  const lines: Card["lines"] = [
    {
      text: `rocky hears ${counts.failures} failure, ${counts.fixes} fix, ${counts.whys} why.`,
      token: "text",
    },
  ];
  if (recent.length > 0) {
    lines.push({ text: "" });
    for (const h of recent) {
      facts.push(h.agoText, h.source);
      lines.push({ text: h.label, token: h.machine ? "muted" : "text2" });
      lines.push({ text: `${h.agoText} · ${h.source}`, token: "muted", indent: 2 });
    }
  }
  lines.push({ text: "" });
  lines.push({ text: "reviewer may ask: what changed, and why, question", token: "text2" });
  return {
    kind: "brief",
    accent: "guard",
    subject: "since 24h",
    meta: `${counts.heard} records`,
    facts,
    lines,
  };
}

export function buildRun(cmd: string, o: RunOutcome): Card {
  const isOk = o.displayCode === 0;
  const facts = [cmd, `exit ${o.displayCode}`];
  const lines: Card["lines"] = [];
  for (const l of o.out) lines.push({ text: l, token: "text2" });
  for (const l of o.err) lines.push({ text: l, token: "err" });
  if (lines.length === 0) lines.push({ text: "(no output)", token: "muted" });
  lines.push({ text: "" });
  lines.push(
    isOk
      ? { text: "clean exit. rocky hears, not worried.", token: "muted" }
      : { text: "failure heard. rocky remembers this one, question", token: "guard" },
  );
  return {
    kind: "run",
    accent: isOk ? "ok" : "err",
    subject: cmd,
    meta: `exit ${o.displayCode}`,
    facts,
    lines,
  };
}

export function buildHelp(commands: readonly Command[]): Card {
  const facts = ["slash optional"];
  const lines: Card["lines"] = commands.map((c) => {
    const cmdStr = c.usage ? `${c.name} ${c.usage}` : c.name;
    return { text: `/${cmdStr.padEnd(13)}${c.help}`, token: "text2" };
  });
  return {
    kind: "help",
    accent: "text2",
    subject: "slash optional",
    meta: "",
    facts,
    lines,
  };
}

export function buildYou(input: string): Card {
  return {
    kind: "you",
    accent: "accent",
    subject: input,
    meta: "",
    facts: [input],
    lines: [],
  };
}

export function buildError(input: string, valid: readonly Command[]): Card {
  const names = valid.map((c) => c.name).join(", ");
  const facts = [input, "try again, question"];
  const lines: Card["lines"] = [
    { text: `not command. rocky hears: ${names}. try again, question`, token: "muted" },
  ];
  return {
    kind: "error",
    accent: "err",
    subject: input,
    meta: "",
    facts,
    lines,
  };
}
