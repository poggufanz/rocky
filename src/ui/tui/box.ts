import { padToWidth, stringWidth, truncateToWidth } from "./width.js";

export interface BoxOptions {
  title: string;
  lines: string[];
  width: number;
  height: number;
  ascii: boolean;
}

export function renderBox(options: BoxOptions): string[] {
  const { title, lines, width, height, ascii } = options;
  if (height <= 0) return [];
  if (width <= 0) return Array.from({ length: height }, () => "");

  const [tl, tr, bl, br, h, v] = ascii
    ? ["+", "+", "+", "+", "-", "|"]
    : ["╭", "╮", "╰", "╯", "─", "│"];

  if (width === 1) {
    if (height === 1) return [tl];
    const rows = [tl];
    for (let i = 0; i < height - 2; i++) rows.push(v);
    rows.push(bl);
    return rows;
  }

  const innerWidth = Math.max(0, width - 2);

  let top: string;
  if (title !== "" && innerWidth >= 4) {
    const maxTitleWidth = innerWidth - 3;
    const cappedTitle = ` ${truncateToWidth(title, maxTitleWidth)} `;
    const topFill = Math.max(0, innerWidth - 1 - stringWidth(cappedTitle));
    top = `${tl}${h}${cappedTitle}${h.repeat(topFill)}${tr}`;
  } else {
    top = `${tl}${h.repeat(innerWidth)}${tr}`;
  }

  if (height === 1) return [top];

  const bottom = `${bl}${h.repeat(innerWidth)}${br}`;
  const rows: string[] = [top];
  const interiorRows = Math.max(0, height - 2);
  for (let i = 0; i < interiorRows; i++) {
    const raw = lines[i] ?? "";
    const content = innerWidth === 0 ? "" : padToWidth(truncateToWidth(raw, innerWidth), innerWidth);
    rows.push(`${v}${content}${v}`);
  }
  rows.push(bottom);
  return rows;
}
