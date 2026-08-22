import { wrapToWidth } from "../core/text.js";
import type { ThemeToken } from "../theme.js";

export interface CardLine {
  text: string;
  token?: ThemeToken;
  indent?: number;
}

export interface Card {
  kind: string;
  accent: ThemeToken;
  subject: string;
  meta?: string;
  lines: CardLine[];
  actions?: string;
  facts: string[];
}

export function toLine(card: Card): string {
  const meta = card.meta ? `: ${card.meta}` : "";
  const first = card.lines.find((l) => l.text.trim() !== "")?.text ?? "";
  return `[Rocky] ${card.kind} ${card.subject}${meta}. ${first}`.trimEnd();
}

export function toBlock(card: Card, width: number): string[] {
  const out: string[] = [`${card.kind} · ${card.subject}${card.meta ? ` · ${card.meta}` : ""}`];
  for (const l of card.lines) {
    const pad = " ".repeat(2 + (l.indent ?? 0));
    for (const w of wrapToWidth(l.text, Math.max(8, width - pad.length))) out.push(pad + w);
  }
  return out;
}

export function panelRows(card: Card, width: number): CardLine[] {
  const rows: CardLine[] = [{ text: `HEADER ${card.kind} ${card.subject}${card.meta ? ` ${card.meta}` : ""}` }];
  for (const l of card.lines) {
    for (const w of wrapToWidth(l.text, Math.max(8, width - 2 - (l.indent ?? 0)))) {
      rows.push({ text: w, token: l.token, indent: l.indent });
    }
  }
  if (card.actions !== undefined) rows.push({ text: card.actions, token: "muted" });
  rows.push({ text: "" });
  return rows;
}

/** The §10.9 gate: a fact present in one density and absent in another is a bug. */
export function assertParity(card: Card, width = 80): void {
  const unwrap = (s: string) => s.replace(/\s+/g, " ");
  const densities: Array<[string, string]> = [
    ["line", unwrap(toLine(card))],
    ["block", unwrap(toBlock(card, width).join(" "))],
    ["panel", unwrap(panelRows(card, width).map((r) => r.text).join(" "))],
  ];
  for (const fact of card.facts) {
    const f = unwrap(fact);
    for (const [name, body] of densities) {
      if (name === "line" && !(f === unwrap(card.subject) || f === unwrap(card.meta ?? ""))) continue;
      // line density carries subject+meta; body facts ride block/panel
      if (!body.includes(f)) throw new Error(`fact "${fact}" missing from ${name} density`);
    }
  }
}
