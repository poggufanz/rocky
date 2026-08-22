import { pulse } from "../core/motion.js";
import { Node, type NodeProps } from "../core/node.js";
import { padToWidth, stringWidth } from "../core/text.js";
import type { CellBuffer } from "../core/buffer.js";
import type { ThemeToken } from "../theme.js";
import type { Card } from "../cards/card.js";

export type Mood = "idle" | "listening" | "thinking" | "heard-fail" | "remembered";

const PENTAGON = [
  "  ═╦═══════╦═ ",
  "   ║ ┌───┐ ║  ",
  "   ╲_││││││_╱  ",
  "   ╱ ╲▔▔▔╱ ╲  ",
  "  ╱ ╱ ╲_╱ ╲ ╲ ",
];

const SLIT_ROW = 1;
const LEG_ROWS = [2, 3, 4];

const MOOD_TOKEN: Record<Mood, ThemeToken> = {
  idle: "text2",
  listening: "accent",
  thinking: "why",
  "heard-fail": "err",
  remembered: "ok",
};

function slitInterior(row: string): { start: number; len: number } {
  const open = row.indexOf("┌");
  const close = row.indexOf("┐");
  if (open === -1 || close === -1 || close < open) return { start: 1, len: 0 };
  return { start: open + 1, len: close - open - 1 };
}

function replaceRange(row: string, start: number, len: number, text: string): string {
  return row.slice(0, start) + text + row.slice(start + len);
}

function shiftRow(row: string, delta: number): string {
  if (delta > 0) return " ".repeat(delta) + row.slice(0, Math.max(0, row.length - delta));
  if (delta < 0) {
    const cut = Math.min(row.length - 1, -delta);
    return row.slice(cut) + " ".repeat(cut);
  }
  return row;
}

export function carapaceLines(mood: Mood, frame: number, ascii: boolean, enabled: boolean): string[] {
  if (ascii) return [];
  const rows = [...PENTAGON];
  const slit = slitInterior(rows[SLIT_ROW]);
  if (mood === "listening" && slit.len > 0) {
    rows[SLIT_ROW] = replaceRange(rows[SLIT_ROW], slit.start, slit.len, "╍".repeat(slit.len));
  }
  if (mood === "thinking" && slit.len > 0) {
    const idx = enabled ? frame : 0;
    const pos = idx % slit.len;
    const mark = pulse(idx, enabled, slit.len * 2) ? "╍" : "·";
    const inner = "─".repeat(slit.len);
    rows[SLIT_ROW] = replaceRange(rows[SLIT_ROW], slit.start, slit.len, inner.slice(0, pos) + mark + inner.slice(pos + 1));
  }
  for (const i of LEG_ROWS) {
    if (mood === "heard-fail") rows[i] = shiftRow(rows[i], 1);
    if (mood === "remembered") rows[i] = shiftRow(rows[i], -1);
  }
  const width = Math.max(...rows.map((r) => stringWidth(r)));
  return rows.map((r) => padToWidth(r, width));
}

const FIX_KINDS = new Set(["fix", "association"]);

export function moodFor(state: { runningCount: number; lastCard?: Card; typing?: boolean }): Mood {
  if (state.runningCount > 0) return "thinking";
  if (state.typing) return "listening";
  const card = state.lastCard;
  if (card) {
    if (card.accent === "err" && (card.kind === "run" || card.kind === "failure")) return "heard-fail";
    if (card.kind === "failure") return "heard-fail";
    if ((card.accent === "ok" && card.kind === "run") || FIX_KINDS.has(card.kind)) return "remembered";
  }
  return "idle";
}

export class CarapaceNode extends Node {
  constructor(
    readonly mood: Mood,
    readonly frame: number,
    readonly ascii: boolean,
    readonly enabled: boolean,
    props: NodeProps = {},
  ) {
    super(props);
  }

  override paint(buf: CellBuffer): void {
    const lines = carapaceLines(this.mood, this.frame, this.ascii, this.enabled);
    const { x, y, w, h } = this.rect;
    if (w <= 0 || h <= 0 || lines.length === 0) return;
    const artW = stringWidth(lines[0]);
    const x0 = x + Math.max(0, Math.floor((w - artW) / 2));
    const y0 = y + Math.max(0, Math.floor((h - lines.length) / 2));
    const token = MOOD_TOKEN[this.mood];
    for (let i = 0; i < lines.length && i < h; i++) {
      buf.blitText(x0, y0 + i, lines[i], token, this.rect);
    }
  }
}
