import { renderBox } from "./box.js";
import { paint, type ColorDepth, type ThemeToken } from "./theme.js";
import { padToWidth, truncateToWidth } from "./width.js";
import {
  visibleRows,
  type DashRow,
  type DashState,
  type TabId,
  type BadgeId,
} from "./state.js";

const BADGE_MAP: Record<BadgeId, string> = {
  fail: "[x]",
  fix: "[+]",
  why: "[*]",
  guard: "[!]",
};

const TAB_LABELS: Record<TabId, string> = {
  info: "Info",
  rationale: "Rationale",
  diff: "Diff",
  json: "JSON",
};

const TAB_ORDER: TabId[] = ["info", "rationale", "diff", "json"];

function paintBoxLines(
  lines: string[],
  depth: ColorDepth,
  isFocused: boolean,
  customInterior?: (content: string, index: number) => string,
): string[] {
  if (depth === 1) return lines;
  const borderToken: ThemeToken = isFocused ? "accent" : "border";
  return lines.map((line, index) => {
    if (index === 0 || index === lines.length - 1) {
      return line.replace(/[╭╮╰╯─+]/g, (ch) => paint(borderToken, ch, depth));
    }
    if (line.length < 2) return line;
    const leftV = line[0];
    const rightV = line[line.length - 1];
    let inner = line.slice(1, -1);
    if (customInterior) {
      inner = customInterior(inner, index - 1);
    }
    return `${paint(borderToken, leftV, depth)}${inner}${paint(borderToken, rightV, depth)}`;
  });
}

function renderHeader(
  state: DashState,
  cols: number,
  depth: ColorDepth,
): string {
  const coverage = state.coverageLine ? ` · ${state.coverageLine}` : "";
  const title = ` rocky dash ── repo rocky-cli${coverage}`;
  const padded = padToWidth(truncateToWidth(title, cols), cols);
  if (depth === 1) return padded;
  return padded.replace("rocky dash", paint("accent", "rocky dash", depth));
}

function renderHints(
  state: DashState,
  cols: number,
  depth: ColorDepth,
): string {
  let text = "";
  if (state.help) {
    text = "press any key to close help";
  } else if (state.search.active) {
    text = " [Enter] keep filter  [Esc] cancel search  [Backspace] delete";
  } else if (state.fullDiff) {
    text = " [Tab] pane  [[/]] tab  [j/k] scroll  [d] diff  [/] search  [?] help  [Esc] back  [q] quit";
  } else if (state.focus === "inspector") {
    text = " [Tab] pane  [[/]] tab  [j/k] scroll  [d] diff  [/] search  [?] help  [Esc] back  [q] quit";
  } else {
    text = " [Tab] pane  [j/k] move  [f] filter  [/] search  [?] help  [q] quit";
  }
  const padded = padToWidth(truncateToWidth(text, cols), cols);
  if (depth === 1) return padded;
  return padded.replace(/\[[^\]]+\]/g, (match) => paint("accent", match, depth));
}

function renderHelpPane(
  cols: number,
  rows: number,
  ascii: boolean,
  depth: ColorDepth,
): string[] {
  const helpLines = [
    "global keys:",
    "  [Tab] / [Shift+Tab]  cycle pane focus",
    "  [?]                  toggle help overlay",
    "  [r]                  reload memory from disk",
    "  [q] / [Ctrl+C]       quit rocky dash",
    "",
    "list pane:",
    "  [j] / [k] or [↓] / [↑]  move selection",
    "  [Ctrl+d] / [Ctrl+u]     half-page down / up",
    "  [g] / [G]               jump to top / bottom",
    "  [f]                     cycle filter (all, failures, triples, sessions, invariants)",
    "  [/]                     search records (live filter)",
    "  [Enter]                 open inspector",
    "",
    "inspector pane:",
    "  [[] / []]               previous / next tab (info, rationale, diff, json)",
    "  [j] / [k], [g] / [G]    scroll content",
    "  [Ctrl+d] / [Ctrl+u]     half-page scroll",
    "  [d]                     toggle full diff",
    "  [Esc]                   back to list",
    "",
    "esc precedence (strict order):",
    "  1. close help overlay",
    "  2. cancel / clear search modal",
    "  3. exit full diff view",
    "  4. inspector back to list",
    "  5. top level: no-op (never quit on esc)",
    "",
    "press any key to close help",
  ];

  const box = renderBox({
    title: "help · keybindings",
    lines: helpLines,
    width: cols,
    height: rows,
    ascii,
  });

  return paintBoxLines(box, depth, true);
}

function renderListPane(
  state: DashState,
  width: number,
  height: number,
  ascii: boolean,
  depth: ColorDepth,
  isFocused: boolean,
): string[] {
  const title = `records · filter: ${state.filter} (f)`;
  const visible = visibleRows(state);
  const total = visible.length;
  const interiorHeight = Math.max(0, height - 2);

  const contentLines: string[] = [];

  if (state.allRows.length === 0) {
    contentLines.push("nothing remembered yet. run command through rocky run, memory grow.");
  } else if (total === 0) {
    const q = state.search.query ? state.search.query : state.filter;
    contentLines.push(`no match for "${q}". filter hear nothing.`);
  } else {
    const maxItems = Math.max(1, interiorHeight - 1);
    const selected = Math.min(Math.max(0, state.selected), total - 1);
    let scrollStart = 0;
    if (selected >= maxItems) {
      scrollStart = selected - maxItems + 1;
    }
    const end = Math.min(total, scrollStart + maxItems);
    for (let i = scrollStart; i < end; i++) {
      const row = visible[i];
      const isSelected = i === selected;
      const marker = isSelected ? (ascii ? "> " : "› ") : "  ";
      const badge = BADGE_MAP[row.badge] ?? "[*]";
      const line = `${marker}${badge} ${row.label}`;
      contentLines.push(line);
    }
  }

  const lines: string[] = [];
  if (interiorHeight === 1) {
    lines.push(contentLines[0] ?? "");
  } else if (interiorHeight >= 2) {
    const maxContentLines = interiorHeight - 1;
    for (let i = 0; i < maxContentLines; i++) {
      lines.push(contentLines[i] ?? "");
    }
    const searchStatus = state.search.query ? state.search.query : "none";
    const currentNum = total === 0 ? 0 : Math.min(Math.max(0, state.selected) + 1, total);
    const footer = `${currentNum} of ${total} · search: ${searchStatus}`;
    lines.push(footer);
  }

  const box = renderBox({
    title,
    lines,
    width,
    height,
    ascii,
  });

  return paintBoxLines(box, depth, isFocused, (inner) => {
    let res = inner;
    res = res.replace(/(\[[x+*!]\])/g, (match) => {
      if (match === "[x]") return paint("err", match, depth);
      if (match === "[+]") return paint("ok", match, depth);
      if (match === "[*]") return paint("why", match, depth);
      if (match === "[!]") return paint("guard", match, depth);
      return match;
    });
    res = res.replace(/(›|>)/g, (marker) => paint("accent", marker, depth));
    return res;
  });
}

function renderInspectorPane(
  state: DashState,
  width: number,
  height: number,
  ascii: boolean,
  depth: ColorDepth,
  isFocused: boolean,
): string[] {
  const tabs = TAB_ORDER
    .map((t) => (t === state.tab ? `[${TAB_LABELS[t]}]` : TAB_LABELS[t]))
    .join(" ");
  const title = `inspector ── ${tabs}`;

  const visible = visibleRows(state);
  const selectedRow = visible[state.selected];

  const rawLines: string[] = [];
  if (!selectedRow) {
    rawLines.push("(no record selected)");
  } else {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(selectedRow.json);
    } catch {
      // ignore
    }

    if (state.tab === "info") {
      rawLines.push(`id         ${selectedRow.id}`);
      rawLines.push(`kind       ${selectedRow.kind}`);
      rawLines.push(`badge      ${selectedRow.badge}`);
      if (selectedRow.label) {
        rawLines.push(`label      ${selectedRow.label}`);
      }
      if (parsed.cmd) {
        rawLines.push(`cmd        ${parsed.cmd}`);
      }
      if (parsed.cwd) {
        rawLines.push(`cwd        ${parsed.cwd}`);
      }
      if (parsed.file) {
        rawLines.push(`file       ${parsed.file}`);
      }
      if (parsed.intent) {
        rawLines.push(`intent     ${parsed.intent}`);
      }
      if (parsed.note) {
        rawLines.push(`note       ${parsed.note}`);
      }
      if (parsed.failureId) {
        rawLines.push(`failureId  ${parsed.failureId}`);
      }
      if (selectedRow.ts > 0) {
        rawLines.push(`timestamp  ${new Date(selectedRow.ts).toISOString()}`);
      }
      if (parsed.fingerprint) {
        rawLines.push(`fingerprint ${parsed.fingerprint}`);
      }
    } else if (state.tab === "rationale") {
      // Fields arrive in two shapes: plain strings (rationale records keep
      // their text in `excerpt`) and nested `{ text }` objects (triples nest
      // intent/rationale that way).
      const asText = (value: unknown): string | undefined => {
        if (typeof value === "string" && value.trim()) return value;
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          const text = (value as Record<string, unknown>).text;
          if (typeof text === "string" && text.trim()) return text;
        }
        return undefined;
      };
      const intentText = asText(parsed.intent);
      const whyText = asText(parsed.rationale)
        ?? (typeof parsed.excerpt === "string" && parsed.excerpt.trim() ? parsed.excerpt : undefined);
      if (intentText !== undefined) {
        rawLines.push(`intent: ${intentText}`);
        if (whyText !== undefined) rawLines.push("");
      }
      if (whyText !== undefined) {
        rawLines.push(...whyText.split("\n"));
      } else if (intentText === undefined) {
        if (typeof parsed.note === "string" && parsed.note.trim()) {
          rawLines.push(...parsed.note.split("\n"));
        } else if (Array.isArray(parsed.excerpt) && parsed.excerpt.length > 0) {
          rawLines.push("excerpt:");
          for (const line of parsed.excerpt) {
            rawLines.push(`  ${line}`);
          }
        } else {
          rawLines.push(`label: ${selectedRow.label}`);
          rawLines.push("");
          rawLines.push("(no additional rationale recorded)");
        }
      }
    } else if (state.tab === "diff") {
      if (state.diff.state === "loading") {
        rawLines.push("loading… (fetching git diff)");
      } else if (state.diff.state === "ready") {
        if (state.diff.lines.length > 0) {
          rawLines.push(...state.diff.lines);
        } else {
          rawLines.push("(empty diff)");
        }
      } else if (state.diff.state === "unavailable") {
        rawLines.push("(git diff unavailable)");
      } else {
        rawLines.push("(git diff unavailable)");
      }
    } else if (state.tab === "json") {
      rawLines.push(...selectedRow.json.split("\n"));
    }
  }

  const scroll = Math.max(0, state.scroll.inspector);
  const scrolledLines = rawLines.slice(scroll);

  const box = renderBox({
    title,
    lines: scrolledLines,
    width,
    height,
    ascii,
  });

  return paintBoxLines(box, depth, isFocused, (inner) => {
    if (state.tab === "diff") {
      if (inner.startsWith("+")) return paint("diffAdd", inner, depth);
      if (inner.startsWith("-")) return paint("diffDel", inner, depth);
      if (inner.startsWith("@")) return paint("diffHunk", inner, depth);
    }
    return inner;
  });
}

function renderSplitPanes(
  state: DashState,
  cols: number,
  rows: number,
  ascii: boolean,
  depth: ColorDepth,
): string[] {
  const leftWidth = Math.floor(cols * 0.45);
  const rightWidth = cols - leftWidth;

  const leftLines = renderListPane(
    state,
    leftWidth,
    rows,
    ascii,
    depth,
    state.focus === "list",
  );
  const rightLines = renderInspectorPane(
    state,
    rightWidth,
    rows,
    ascii,
    depth,
    state.focus === "inspector",
  );

  const result: string[] = [];
  for (let i = 0; i < rows; i++) {
    const left = leftLines[i] ?? "";
    const right = rightLines[i] ?? "";
    result.push(`${left}${right}`);
  }
  return result;
}

function renderStackedPane(
  state: DashState,
  cols: number,
  rows: number,
  ascii: boolean,
  depth: ColorDepth,
): string[] {
  if (state.focus === "inspector" || state.inspectorOpen) {
    return renderInspectorPane(state, cols, rows, ascii, depth, true);
  }
  return renderListPane(state, cols, rows, ascii, depth, true);
}

export function render(
  state: DashState,
  viewport: { cols: number; rows: number },
  depth: ColorDepth,
  ascii: boolean,
): string[] {
  const { cols, rows } = viewport;
  if (rows <= 0) return [];
  if (cols <= 0) return Array.from({ length: rows }, () => "");

  if (rows === 1) {
    return [renderHeader(state, cols, depth)];
  }
  if (rows === 2) {
    return [
      renderHeader(state, cols, depth),
      renderHints(state, cols, depth),
    ];
  }

  const header = renderHeader(state, cols, depth);
  const hints = renderHints(state, cols, depth);
  const bodyRows = rows - 2;

  let body: string[];
  if (state.help) {
    body = renderHelpPane(cols, bodyRows, ascii, depth);
  } else if (state.fullDiff) {
    body = renderInspectorPane(state, cols, bodyRows, ascii, depth, true);
  } else if (state.stacked) {
    body = renderStackedPane(state, cols, bodyRows, ascii, depth);
  } else {
    body = renderSplitPanes(state, cols, bodyRows, ascii, depth);
  }

  return [header, ...body, hints];
}
