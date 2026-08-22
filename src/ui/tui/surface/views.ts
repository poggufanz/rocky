import { BoxNode } from "../components/box.js";
import { Node, TextNode, type NodeProps } from "../core/node.js";
import type { ThemeToken } from "../theme.js";
import { deriveHome, type HomeData } from "./home-data.js";
import type { Card } from "../cards/card.js";
import { wrapToWidth, stringWidth } from "../core/text.js";
import { CellBuffer, type Rect } from "../core/buffer.js";
import { InputLineNode, StatusBarNode, SlashMenuNode } from "../components/chrome.js";
import { matchCommands } from "./registry.js";
import { pulse } from "../core/motion.js";
import { getMemorySnapshot, filteredFiles, initialCompareState, browseVisible, shellMood, type ShellState, type CompareState } from "./shell.js";
import { sessionItems, pickList } from "./picker.js";
import { getCachedDiff, type CompareRec } from "./compare-data.js";
import { CarapaceNode } from "../components/carapace.js";
import { elapsed } from "../../rocky.js";
import type { MemoryRecord } from "../../../core/memory-read.js";

const KIND_TOKEN: Record<string, ThemeToken> = {
  failure: "err",
  fix: "ok",
  association: "ok",
  triple: "why",
  rationale: "why",
  note: "why",
  alias: "why",
  brief_run: "text2",
  invariant_touch: "guard",
};

const KIND_BADGE: Record<string, string> = {
  failure: "fail",
  fix: "fix",
  association: "fix",
  triple: "why",
  rationale: "why",
  note: "note",
  alias: "alias",
  brief_run: "brief",
  invariant_touch: "guard",
};

export function homeView(
  data: HomeData,
  size: { cols: number; rows: number },
  ascii: boolean,
): Node {
  const root = new Node({ direction: "column", grow: 1 });
  const topRow = new Node({ direction: "row", grow: 11 });
  const bottomRow = new Node({ direction: "row", grow: 9 });

  // 1. "what rocky holds"
  const holdsBox = new BoxNode({ title: "what rocky holds", ascii, grow: 11 });
  if (data.byKind.length === 0) {
    holdsBox.add(new TextNode("no records yet", "muted"));
    holdsBox.add(new TextNode(data.coverageLine, "muted"));
  } else {
    const max = Math.max(...data.byKind.map((k) => k.count), 1);
    const barMaxW = Math.max(1, Math.floor(size.cols * 0.55) - 28);
    for (const k of data.byKind) {
      const barLen = Math.max(1, Math.round((k.count / max) * barMaxW));
      const bar = "█".repeat(barLen);
      const line = `${k.kind.padEnd(14)} ${String(k.count).padStart(4)}  ${bar}`;
      holdsBox.add(new TextNode(line, KIND_TOKEN[k.kind] ?? "why"));
    }
    holdsBox.add(
      new TextNode(
        `${data.total} record${data.total === 1 ? "" : "s"} · ${data.coverageLine}`,
        "muted",
      ),
    );
  }

  // 2. "since 24h"
  const dayBox = new BoxNode({ title: "since 24h", ascii, grow: 9 });
  dayBox.add(new TextNode(`${"heard".padEnd(14)}${String(data.day.heard).padStart(5)}`, "text"));
  dayBox.add(
    new TextNode(
      `${"failures".padEnd(14)}${String(data.day.failures).padStart(5)}`,
      data.day.failures > 0 ? "err" : "text2",
    ),
  );
  dayBox.add(
    new TextNode(
      `${"fixes".padEnd(14)}${String(data.day.fixes).padStart(5)}`,
      data.day.fixes > 0 ? "ok" : "text2",
    ),
  );
  dayBox.add(
    new TextNode(
      `${"why recorded".padEnd(14)}${String(data.day.whys).padStart(5)}`,
      data.day.whys > 0 ? "why" : "text2",
    ),
  );
  dayBox.add(new TextNode("local only · no egress", "muted"));

  // 3. "most heard files"
  const filesBox = new BoxNode({ title: "most heard files", ascii, grow: 11 });
  if (data.topFiles.length === 0) {
    filesBox.add(new TextNode("  (none heard yet)", "muted"));
  } else {
    for (const file of data.topFiles) {
      filesBox.add(new TextNode(`${String(file.count).padStart(3)} ${file.name}`, "text2"));
    }
  }

  // 4. "recent"
  const recentBox = new BoxNode({ title: "recent", ascii, grow: 9 });
  if (data.recent.length === 0) {
    recentBox.add(new TextNode("  (no recent evidence)", "muted"));
  } else {
    for (const r of data.recent) {
      const badge = KIND_BADGE[r.kind] ?? "why";
      recentBox.add(
        new TextNode(`${badge.padEnd(6)}${r.label}`, r.machine ? "muted" : "text2"),
      );
      recentBox.add(new TextNode(`      ${r.agoText}`, "muted"));
    }
  }

  topRow.add(holdsBox).add(dayBox);
  bottomRow.add(filesBox).add(recentBox);
  root.add(topRow).add(bottomRow);

  return root;
}

export class StreamNode extends Node {
  constructor(readonly cards: Card[], readonly scroll: number, props: NodeProps = { grow: 1 }) {
    super(props);
  }

  override paint(buf: CellBuffer): void {
    const { x, y, w, h } = this.rect;
    if (w <= 0 || h <= 0) return;

    const streamW = Math.min(Math.max(10, w - 2), 110);
    const flat: Array<{
      head?: Card;
      text?: string;
      token?: ThemeToken;
      indent?: number;
      accent: ThemeToken;
    }> = [];

    for (const c of this.cards) {
      flat.push({ head: c, accent: c.accent });
      for (const l of c.lines) {
        if (l.text === "") {
          flat.push({ text: "", token: "muted", accent: c.accent });
          continue;
        }
        const availW = Math.max(8, streamW - 4 - (l.indent ?? 0));
        const wrapped = wrapToWidth(l.text, availW);
        for (const t of wrapped) {
          flat.push({ text: t, token: l.token ?? "text2", indent: l.indent, accent: c.accent });
        }
      }
      if (c.actions !== undefined) {
        flat.push({ text: c.actions, token: "muted", accent: c.accent });
      }
      flat.push({ text: "", token: "muted", accent: c.accent });
    }

    const maxScroll = Math.max(0, flat.length - h);
    const effectiveScroll = Math.max(0, Math.min(this.scroll, maxScroll));
    const start = maxScroll - effectiveScroll;
    const clip: Rect = { x, y, w, h };

    for (let i = 0; i < h; i++) {
      const r = flat[start + i];
      if (!r) continue;
      const lineY = y + i;

      // Gutter accent
      buf.set(x + 1, lineY, "▌", r.accent);

      if (r.head) {
        const c = r.head;
        let cx = x + 3;
        const chip = ` ${c.kind} `;
        for (const ch of chip) {
          buf.set(cx, lineY, ch, c.accent, true);
          cx++;
        }
        cx += 1;
        const metaW = c.meta ? stringWidth(c.meta) : 0;
        const availSubj = Math.max(0, streamW - (cx - x) - metaW - 2);
        buf.blitText(cx, lineY, c.subject, "text", { x: cx, y: lineY, w: availSubj, h: 1 });
        if (c.meta) {
          buf.blitText(x + 1 + streamW - metaW, lineY, c.meta, "muted", clip);
        }
      } else {
        const indent = r.indent ?? 0;
        if (r.text) {
          buf.blitText(x + 3 + indent, lineY, r.text, r.token ?? "text2", clip);
        }
      }
    }

    if (effectiveScroll > 0 && w >= 16) {
      buf.blitText(x + w - 12, y, `↑ ${effectiveScroll}`, "muted", clip);
    }
  }
}

export function streamView(
  cards: Card[],
  scroll: number,
  size: { cols: number; rows: number },
): Node {
  return new StreamNode(cards, scroll, { grow: 1 });
}

export class SurfaceRootNode extends Node {
  private slashNode?: SlashMenuNode;
  private browseNode?: Node;
  constructor(readonly mainColumn: Node, slashNode?: SlashMenuNode, browseOverlay?: Node) {
    super({ direction: "column" });
    this.add(mainColumn);
    if (slashNode) {
      this.slashNode = slashNode;
      this.add(slashNode);
    }
    if (browseOverlay) {
      this.browseNode = browseOverlay;
      this.add(browseOverlay);
    }
  }

  override layout(rect: Rect): void {
    this.rect = rect;
    this.mainColumn.layout(rect);
    if (this.slashNode) {
      const cleanPrefix = this.slashNode.state.prefix.startsWith("/")
        ? this.slashNode.state.prefix.slice(1)
        : this.slashNode.state.prefix;
      const matches = matchCommands(cleanPrefix);
      const mh = matches.length + 2;
      const mw = Math.min(56, Math.max(0, rect.w - 4));
      const inputTop = Math.max(1, rect.h - 4);
      const my = Math.max(1, inputTop - mh);
      this.slashNode.rect = { x: 1, y: my, w: mw, h: mh };
    }
    if (this.browseNode) {
      const bw = Math.min(84, Math.max(30, rect.w - 6));
      const bh = Math.min(rect.h - 2, 18);
      const bx = Math.max(1, rect.w - bw - 3);
      const by = Math.max(1, Math.floor((rect.h - bh) / 2));
      this.browseNode.rect = { x: bx, y: by, w: bw, h: bh };
    }
  }
}

function stamp(ts: number): string {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? "unknown" : d.toISOString().slice(0, 16).replace("T", " ");
}

function ago(ts: number, now: number): string {
  const span = elapsed(Math.max(0, now - ts));
  return span === "just now" ? span : `${span} ago`;
}

function cut(s: string, maxW: number): string {
  if (stringWidth(s) <= maxW) return s;
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = stringWidth(ch);
    if (w + cw > maxW - 1) break;
    out += ch;
    w += cw;
  }
  return out + "…";
}

function displayText(r: CompareRec): string {
  if (r.machine) return r.summary ?? "agent notification";
  return r.intent ?? r.reason ?? r.kind;
}

function paintBox(buf: CellBuffer, rect: Rect, title?: string, focused = false, ascii = false): Rect {
  const { x, y, w, h } = rect;
  if (w <= 0 || h <= 0) return { x, y, w: 0, h: 0 };
  buf.fillRect(rect, " ");
  const [tl, tr, bl, br, horiz, vert] = ascii
    ? ["+", "+", "+", "+", "-", "|"]
    : ["┌", "┐", "└", "┘", "─", "│"];
  const borderToken: ThemeToken = "border";

  buf.set(x, y, tl, borderToken);
  if (w > 1) buf.set(x + w - 1, y, tr, borderToken);
  if (h > 1) {
    buf.set(x, y + h - 1, bl, borderToken);
    if (w > 1) buf.set(x + w - 1, y + h - 1, br, borderToken);
  }
  for (let c = 1; c < w - 1; c++) {
    buf.set(x + c, y, horiz, borderToken);
    if (h > 1) buf.set(x + c, y + h - 1, horiz, borderToken);
  }
  for (let r = 1; r < h - 1; r++) {
    buf.set(x, y + r, vert, borderToken);
    if (w > 1) buf.set(x + w - 1, y + r, vert, borderToken);
  }
  if (title && w >= 4) {
    const maxTitleW = Math.max(0, w - 4);
    const titleStr = ` ${title} `;
    let cx = x + 2;
    let usedW = 0;
    const token: ThemeToken = focused ? "accent" : "text2";
    for (const ch of titleStr) {
      const cw = stringWidth(ch);
      if (cw === 0) continue;
      if (usedW + cw > maxTitleW) break;
      buf.set(cx, y, ch, token, focused);
      if (cw === 2) buf.set(cx + 1, y, "\u0000", token, focused);
      cx += cw;
      usedW += cw;
    }
  }
  return {
    x: x + 2,
    y: y + 1,
    w: Math.max(0, w - 4),
    h: Math.max(0, h - 2),
  };
}

export class CompareViewNode extends Node {
  constructor(
    readonly state: CompareState,
    readonly size: { cols: number; rows: number },
    readonly frame: number,
    readonly ascii: boolean,
    readonly allRecords?: MemoryRecord[],
    readonly motionOn: boolean = true,
    readonly now: number = Date.now(),
  ) {
    super();
  }

  override paint(buf: CellBuffer): void {
    const cols = this.rect.w > 0 ? this.rect.w : this.size.cols;
    const rows = this.rect.h > 0 ? this.rect.h : this.size.rows;
    if (cols <= 0 || rows <= 0) return;

    this.state.rects = {};
    buf.fillRect({ x: 0, y: 0, w: cols, h: rows }, " ");

    const totalRecs = this.allRecords?.length ?? this.state.records.length;
    const files = this.state.files;

    // 1. Header line (y = 0, h = 1)
    let hx = 1;
    hx += buf.blitText(hx, 0, " ROCKY ", "accent", undefined) + 1;
    hx += buf.blitText(hx, 0, `${totalRecs} remembered · ${files.length} files`, "text2") + 1;
    const mood = this.state.file
      ? `≣ holding ${cut(this.state.file.path.split("/").slice(-1)[0], 22)}`
      : "≣ listening";
    buf.blitText(cols - stringWidth(mood) - 2, 0, mood, "accent");

    const top = 1;
    const inputH = 3;
    const statusH = 1;
    const bodyH = Math.max(1, rows - top - inputH - statusH);
    const rightW = Math.max(30, Math.min(38, Math.floor(cols * 0.32)));
    const leftW = Math.max(1, cols - rightW);
    const sumH = 9;
    const filesH = Math.max(1, bodyH - sumH);

    // 2. Right column: Summary + Files list
    const sumInner = paintBox(buf, { x: leftW, y: top, w: rightW, h: sumH }, "file", false, this.ascii);
    const f = this.state.file ?? filteredFiles(this.state)[this.state.fsel];
    if (!f) {
      buf.blitText(sumInner.x, sumInner.y, "no file match.", "muted");
    } else {
      const filename = f.path.split("/").slice(-1)[0];
      const dirname = f.path.split("/").slice(0, -1).join("/");
      buf.blitText(sumInner.x, sumInner.y, cut(filename, sumInner.w), "text");
      buf.blitText(sumInner.x, sumInner.y + 1, cut(dirname, sumInner.w), "muted");

      const counts = new Map<string, number>();
      for (const r of f.recs) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
      const sortedCounts = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
      let bx = sumInner.x;
      for (const [k, n] of sortedCounts) {
        const badge = KIND_BADGE[k] ?? k;
        const token = KIND_TOKEN[k] ?? "why";
        const chip = ` ${badge} ${n} `;
        if (bx + stringWidth(chip) > sumInner.x + sumInner.w) break;
        for (const ch of chip) {
          buf.set(bx, sumInner.y + 3, ch, token, true);
          bx++;
        }
        bx += 1;
      }
      buf.blitText(sumInner.x, sumInner.y + 5, `${f.count} records`, "text2");
      buf.blitText(sumInner.x, sumInner.y + 6, `first ${ago(f.firstTs, this.now)} · last ${ago(f.lastTs, this.now)}`, "muted");
    }

    const filesInner = paintBox(
      buf,
      { x: leftW, y: top + sumH, w: rightW, h: filesH },
      `files · ${filteredFiles(this.state).length}`,
      this.state.focus === "files",
      this.ascii,
    );
    const fileList = filteredFiles(this.state);
    this.state.rects.files = filesInner;
    if (this.state.fsel < this.state.ftop) this.state.ftop = this.state.fsel;
    if (this.state.fsel >= this.state.ftop + filesInner.h) {
      this.state.ftop = this.state.fsel - filesInner.h + 1;
    }
    for (let i = 0; i < filesInner.h; i++) {
      const fi = fileList[this.state.ftop + i];
      if (!fi) break;
      const lineY = filesInner.y + i;
      const on = this.state.ftop + i === this.state.fsel;
      if (on) {
        buf.set(filesInner.x - 1, lineY, "▎", "accent");
      }
      let fx = filesInner.x;
      fx += buf.blitText(fx, lineY, String(fi.count).padStart(3), "accent") + 1;
      buf.blitText(
        fx,
        lineY,
        cut(fi.path.split("/").slice(-1)[0], filesInner.w - (fx - filesInner.x)),
        on ? "text" : "text2",
      );
    }
    if (fileList.length === 0) {
      buf.blitText(filesInner.x, filesInner.y + 1, "filter hear nothing.", "muted");
    }

    // 3. Left column
    const zoomed = this.state.zoom && this.state.file && this.state.focus !== "files" ? this.state.focus : null;

    if (!this.state.file) {
      const compInner = paintBox(buf, { x: 0, y: top, w: leftW, h: bodyH }, "comparison", false, this.ascii);
      buf.blitText(compInner.x, compInner.y + 1, "nothing chosen yet.", "text2");
      buf.blitText(compInner.x, compInner.y + 3, "pick file on right, press enter.", "muted");
      buf.blitText(compInner.x, compInner.y + 4, "rocky asks: all history, or two moments, question", "muted");
    } else if (this.state.mode === "all") {
      const short = this.state.file.path.split("/").slice(-2).join("/");
      if (zoomed === "diffA") {
        this.paintDiffPane(buf, 0, top, leftW, bodyH, this.state.file.recs[0], "");
      } else {
        const diffH = this.state.showDiff && !zoomed ? Math.min(13, Math.floor(bodyH / 2)) : 0;
        const compH = bodyH - diffH;
        this.state.rects.compare = { x: 0, y: top, w: leftW, h: compH };
        const compInner = paintBox(
          buf,
          { x: 0, y: top, w: leftW, h: compH },
          `all history · ${cut(short, leftW - 24)}`,
          this.state.focus === "compare",
          this.ascii,
        );
        // Paint all history evidence lines
        const lines: Array<{ day?: string; badge?: string; badgeToken?: ThemeToken; text: string; indent?: number; muted?: boolean }> = [];
        let curDay = "";
        for (const r of this.state.file.recs) {
          const d = new Date(r.ts).toISOString().slice(0, 10);
          if (d !== curDay) {
            curDay = d;
            lines.push({ day: d, text: d });
          }
          const badge = KIND_BADGE[r.kind] ?? "why";
          const token = KIND_TOKEN[r.kind] ?? "why";
          const disp = displayText(r).replace(/\s+/g, " ");
          lines.push({ badge, badgeToken: token, text: cut(disp, compInner.w - 9) });
          for (const wrapped of wrapToWidth(disp, compInner.w - 9).slice(1, 3)) {
            lines.push({ text: wrapped, indent: 9, muted: true });
          }
          lines.push({
            text: `${stamp(r.ts)}${r.source ? ` · ${r.source}` : ""}`,
            indent: 9,
            muted: true,
          });
        }

        const maxScroll = Math.max(0, lines.length - compInner.h);
        this.state.cscroll = Math.max(0, Math.min(this.state.cscroll, maxScroll));
        for (let i = 0; i < compInner.h; i++) {
          const l = lines[this.state.cscroll + i];
          if (!l) break;
          const yy = compInner.y + i;
          if (l.day) {
            buf.blitText(compInner.x, yy, ` ${l.day} `, "text2");
            continue;
          }
          if (l.badge) {
            let lx = compInner.x;
            for (const ch of ` ${l.badge} `) {
              buf.set(lx, yy, ch, l.badgeToken ?? "why", true);
              lx++;
            }
            lx += 1;
            buf.blitText(lx, yy, l.text, "text");
            continue;
          }
          buf.blitText(compInner.x + (l.indent ?? 0), yy, l.text, l.muted ? "muted" : "text2");
        }

        if (diffH > 0) {
          this.paintDiffPane(buf, 0, top + compH, leftW, diffH, this.state.file.recs[0], "");
        }
      }
    } else {
      // mode === "two"
      const halfW = Math.floor(leftW / 2);
      const rightHalfW = leftW - halfW;
      if (zoomed === "diffA" || zoomed === "diffB") {
        this.paintDiffPane(buf, 0, top, halfW, bodyH, this.state.recA, "A");
        this.paintDiffPane(buf, halfW, top, rightHalfW, bodyH, this.state.recB, "B");
      } else {
        const diffH = this.state.showDiff && !zoomed ? Math.min(13, Math.floor(bodyH / 2)) : 0;
        const recH = bodyH - diffH;
        this.state.rects.recA = { x: 0, y: top, w: halfW, h: recH };
        this.state.rects.recB = { x: halfW, y: top, w: rightHalfW, h: recH };
        const rowsA = this.recordBodyRows(this.state.recA, Math.max(0, halfW - 4), this.state.expA);
        const rowsB = this.recordBodyRows(this.state.recB, Math.max(0, rightHalfW - 4), this.state.expB);
        const viewH = Math.max(1, Math.max(1, recH - 2) - 3);
        this.state.cscroll = Math.max(0, Math.min(this.state.cscroll, Math.max(0, Math.max(rowsA.length, rowsB.length) - viewH)));
        this.paintRecordPane(buf, 0, top, halfW, recH, this.state.recA, "A", this.state.expA, this.state.focus === "recA");
        this.paintRecordPane(buf, halfW, top, rightHalfW, recH, this.state.recB, "B", this.state.expB, this.state.focus === "recB");

        if (this.state.recA && this.state.recB && this.state.file) {
          const between = this.state.file.recs.filter(
            (r) => r.ts > Math.min(this.state.A ?? 0, this.state.B ?? 0) && r.ts < Math.max(this.state.A ?? 0, this.state.B ?? 0),
          ).length;
          const hrs = Math.max(0, Math.round(Math.abs((this.state.B ?? 0) - (this.state.A ?? 0)) / 3600000));
          const note = ` ${between} records between · ${hrs}h apart `;
          buf.blitText(leftW - stringWidth(note) - 2, top + recH - 1, note, "muted");
        }

        if (diffH > 0) {
          this.paintDiffPane(buf, 0, top + recH, halfW, diffH, this.state.recA, "A");
          this.paintDiffPane(buf, halfW, top + recH, rightHalfW, diffH, this.state.recB, "B");
        }
      }
    }

    // 4. Bottom filter files box (iy = top + bodyH, h = inputH)
    const iy = top + bodyH;
    const filterInner = paintBox(
      buf,
      { x: 0, y: iy, w: cols, h: inputH },
      "filter files",
      this.state.focus === "files",
      this.ascii,
    );
    buf.blitText(filterInner.x, filterInner.y, "›", "accent");
    const qText = this.state.fquery || "type part of a path…";
    buf.blitText(filterInner.x + 2, filterInner.y, qText, this.state.fquery ? "text" : "muted");
    if (pulse(this.frame, this.motionOn)) {
      buf.blitText(filterInner.x + 2 + (this.state.fquery ? stringWidth(this.state.fquery) : 0), filterInner.y, "▏", "accent");
    }

    // 5. Status bar (sy = rows - 1, h = 1)
    const sy = rows - 1;
    let sx = buf.blitText(0, sy, " ROCKY ", "accent", undefined) + 1;
    const seg = this.state.modal
      ? [["↑↓", "choose"], ["enter", "confirm"], ["esc", "back"]]
      : this.state.focus === "files"
      ? [["type", "filter"], ["↑↓", "pick"], ["enter", "scope"], ["tab", "panes"]]
      : [
          ["pane", this.state.focus],
          ["j/k", "scroll"],
          ["z", this.state.zoom ? "unzoom" : "zoom"],
          ["d", this.state.showDiff ? "hide diff" : "show diff"],
          ["tab", "next"],
          ["/", "filter"],
          ["esc", this.state.zoom ? "unzoom" : "clear"],
        ];
    for (const [a, b] of seg) {
      sx += buf.blitText(sx, sy, ` ${a}`, "accent") + 1;
      sx += buf.blitText(sx, sy, ` ${b} `, "muted") + 1;
    }
    if (cols >= 90) {
      buf.blitText(cols - 24, sy, "local only · no egress", "muted");
    }

    // 6. Modals
    if (this.state.modal === "scope" && this.state.file) {
      const mw = Math.min(64, Math.max(20, cols - 8));
      const mh = 8;
      const mx = Math.floor((cols - mw) / 2);
      const my = Math.floor((rows - mh) / 2) - 2;
      paintBox(buf, { x: mx, y: my, w: mw, h: mh }, "how to hear it", true, this.ascii);
      buf.blitText(mx + 2, my + 1, cut(this.state.file.path, mw - 4), "muted");
      const on0 = this.state.msel === 0;
      buf.blitText(mx + 2, my + 3, (on0 ? "▎ " : "  ") + "all history", on0 ? "text" : "text2");
      buf.blitText(mx + 4, my + 4, "every record rocky holds for this file", "muted");
      const on1 = this.state.msel === 1;
      buf.blitText(mx + 2, my + 5, (on1 ? "▎ " : "  ") + "two moments", on1 ? "text" : "text2");
      buf.blitText(mx + 4, my + 6, "compare what he knew then against now", "muted");
    }

    if (this.state.modal === "timeline" && this.state.file) {
      const list = pickList(this.state.file.recs, this.state.picker);
      const mw = Math.min(58, Math.max(36, cols - 40));
      const mh = rows - 2;
      const mx = Math.max(1, cols - mw);
      const my = 1;
      const phase2 = this.state.picker.markA && this.state.picker.recA;
      paintBox(buf, { x: mx, y: my, w: mw, h: mh }, phase2 ? "timeline · pick B" : "timeline · pick A", true, this.ascii);
      buf.blitText(
        mx + 2,
        my + 1,
        phase2 ? `A locked · ${stamp(this.state.A ?? 0)}` : "cursor previews left, enter locks A",
        "muted",
      );
      buf.blitText(mx + 2, my + 2, "/ ", "accent");
      buf.blitText(mx + 4, my + 2, this.state.picker.tquery || "search intent…", this.state.picker.tquery ? "text" : "muted");
      if (pulse(this.frame, this.motionOn)) {
        buf.blitText(mx + 4 + (this.state.picker.tquery ? stringWidth(this.state.picker.tquery) : 0), my + 2, "▏", "accent");
      }
      if (this.state.picker.tquery) {
        buf.blitText(mx + mw - stringWidth(String(list.length)) - 3, my + 2, String(list.length), "muted");
      }

      const items = sessionItems(list);
      const viewH = mh - 5;
      const curPos = Math.max(0, items.findIndex((it) => it.idx === this.state.picker.tsel));
      const topIdx = Math.max(0, Math.min(curPos - Math.floor(viewH / 2), items.length - viewH));
      for (let i = 0; i < viewH; i++) {
        const it = items[topIdx + i];
        if (!it) break;
        const yy = my + 3 + i;
        if (it.hdr !== undefined) {
          const hdrText = ` session ${it.hdr} · ${stamp(it.ts ?? 0).slice(0, 10)} · ${it.n} records `;
          buf.blitText(mx + 2, yy, cut(hdrText, mw - 4), "text2");
          continue;
        }
        const r = it.rec!;
        const on = it.idx === this.state.picker.tsel;
        if (on) {
          buf.set(mx + 1, yy, "▎", "accent");
        }
        const badge = KIND_BADGE[r.kind] ?? "why";
        const token = KIND_TOKEN[r.kind] ?? "why";
        let bx = mx + 2;
        bx += buf.blitText(bx, yy, stamp(r.ts).slice(5) + " ", on ? "text" : "text2") + 1;
        if (on) {
          for (const ch of ` ${badge} `) {
            buf.set(bx, yy, ch, token, true);
            bx++;
          }
          bx += 1;
        } else {
          bx += buf.blitText(bx, yy, badge.padEnd(6), token) + 1;
        }
        buf.blitText(
          bx,
          yy,
          cut(displayText(r).replace(/\s+/g, " "), mx + mw - bx - 2),
          on ? "text" : r.machine ? "muted" : "text2",
        );
      }
      buf.blitText(
        mx + 2,
        my + mh - 2,
        phase2 ? "[enter] lock B  [←→] session  [esc] unlock A" : "[enter] lock A  [←→] session  [esc] back",
        "muted",
      );
    }
  }

  private recordBodyRows(
    rec: CompareRec | null,
    innerW: number,
    expanded: boolean,
  ): Array<{ label?: string; text?: string; token?: ThemeToken }> {
    if (!rec) return [];
    const rows: Array<{ label?: string; text?: string; token?: ThemeToken }> = [];
    if (rec.machine && !expanded) {
      rows.push({ label: "intent · agent" });
      for (const l of wrapToWidth(displayText(rec), innerW)) rows.push({ text: l, token: "text2" });
      rows.push({ text: "machine note, not human words — [x] show raw", token: "muted" });
    } else if (rec.intent) {
      rows.push({ label: rec.machine ? "intent · agent raw" : "intent" });
      for (const l of wrapToWidth(rec.intent, innerW)) rows.push({ text: l, token: "text2" });
    }
    if (rec.reason) {
      rows.push({ label: "reason" });
      for (const l of wrapToWidth(rec.reason, innerW)) rows.push({ text: l, token: "text" });
    }
    if (!rec.intent && !rec.reason) {
      rows.push({ label: "heard" });
      for (const l of wrapToWidth(displayText(rec), innerW)) rows.push({ text: l, token: "text" });
    }
    return rows;
  }

  private paintRecordPane(
    buf: CellBuffer,
    x: number,
    y: number,
    w: number,
    h: number,
    rec: CompareRec | null,
    side: "A" | "B",
    expanded: boolean,
    focused: boolean,
  ): void {
    const ts = side === "A" ? this.state.A : this.state.B;
    const title = ` ${side} · ${ts ? stamp(ts) : "…"} `;
    const inner = paintBox(buf, { x, y, w, h }, title, focused, this.ascii);
    if (!rec) {
      buf.blitText(inner.x, inner.y, "(no record)", "muted");
      return;
    }

    const badge = KIND_BADGE[rec.kind] ?? "why";
    const token = KIND_TOKEN[rec.kind] ?? "why";
    let bx = inner.x;
    for (const ch of ` ${badge} `) {
      buf.set(bx, inner.y, ch, token, true);
      bx++;
    }
    bx += 1;
    if (rec.source) bx += buf.blitText(bx, inner.y, rec.source, "muted") + 1;
    if (rec.plus !== undefined) {
      const pm = `+${rec.plus} −${rec.minus ?? 0}`;
      buf.blitText(inner.x + inner.w - stringWidth(pm), inner.y, pm, rec.plus ? "ok" : "muted");
    }

    const rows = this.recordBodyRows(rec, inner.w, expanded);
    const viewH = Math.max(1, inner.h - 3);
    for (let i = 0; i < viewH; i++) {
      const r = rows[this.state.cscroll + i];
      if (!r) break;
      const yy = inner.y + 2 + i;
      if (r.label) buf.blitText(inner.x, yy, r.label, "muted");
      else if (r.text) buf.blitText(inner.x, yy, r.text, r.token ?? "text2");
    }

    const foot = rec.head ? `${stamp(rec.ts)}  commit ${rec.head.slice(0, 7)}` : stamp(rec.ts);
    buf.blitText(inner.x, inner.y + inner.h - 1, cut(foot, inner.w - 8), side === "A" ? "why" : "accent");
  }

  private paintDiffPane(
    buf: CellBuffer,
    x: number,
    y: number,
    w: number,
    h: number,
    rec: CompareRec | null,
    label: string,
  ): void {
    const fkey = label === "B" ? "diffB" : "diffA";
    const focused = this.state.focus === fkey;
    if (!this.state.rects) this.state.rects = {};
    this.state.rects[fkey] = { x, y, w, h };
    const filePath = this.state.file?.path ?? "";
    const d = rec ? getCachedDiff(filePath, rec) : { rows: [] };
    let title = label ? `diff ${label}` : "diff";
    if (rec) {
      if (d.commit) title += ` · ${d.prior ? "last change before · " : ""}commit ${d.commit}`;
      else title += ` · ${stamp(rec.ts)}`;
    }
    const inner = paintBox(buf, { x, y, w, h }, cut(title, w - 6), focused, this.ascii);
    if (!rec) return;

    const rows = d.rows;
    const skey = label === "B" ? "dscrollB" : "dscrollA";
    const hkey = label === "B" ? "hscrollB" : "hscrollA";
    const maxScroll = Math.max(0, rows.length - inner.h);
    this.state[skey] = Math.max(0, Math.min(this.state[skey], maxScroll));
    const scroll = this.state[skey];
    const hs = this.state[hkey];

    const NO = 4;
    for (let i = 0; i < inner.h; i++) {
      const r = rows[scroll + i];
      if (!r) break;
      const yy = inner.y + i;
      if (r.k === "m" || r.k === "x") {
        buf.blitText(inner.x, yy, cut(r.t, inner.w), r.k === "x" ? "text2" : "muted");
        continue;
      }
      if (r.k === "h") {
        const panT = hs ? [...r.t].slice(hs).join("") : r.t;
        buf.blitText(inner.x, yy, cut(panT, inner.w), "muted");
        continue;
      }
      if (r.k === "@") {
        const panT = hs ? [...r.t].slice(hs).join("") : r.t;
        buf.blitText(inner.x, yy, cut(panT, inner.w), "diffHunk");
        continue;
      }
      if (r.o !== undefined) buf.blitText(inner.x, yy, String(r.o).padStart(NO), "muted");
      if (r.n !== undefined) buf.blitText(inner.x + NO, yy, String(r.n).padStart(NO), "muted");
      const mk = r.k === "+" ? "+" : r.k === "-" ? "−" : " ";
      const token: ThemeToken = r.k === "+" ? "diffAdd" : r.k === "-" ? "diffDel" : "text2";
      buf.set(inner.x + NO * 2 + 1, yy, mk, token);
      const rawText = r.t.replace(/\t/g, "  ");
      const panT = hs ? [...rawText].slice(hs).join("") : rawText;
      buf.blitText(inner.x + NO * 2 + 3, yy, cut(panT, inner.w - NO * 2 - 3), token);
    }

    const foot = `${hs ? `◂${hs} ` : ""}${Math.min(rows.length, scroll + inner.h)}/${rows.length}`;
    buf.blitText(x + w - stringWidth(foot) - 2, y + h - 1, foot, "muted");
  }
}

export function compareView(
  state: CompareState,
  size: { cols: number; rows: number },
  frame: number,
  ascii: boolean,
  allRecords?: MemoryRecord[],
  motionOn?: boolean,
  now?: number,
): Node {
  return new CompareViewNode(state, size, frame, ascii, allRecords, motionOn ?? true, now ?? Date.now());
}

const LIST_TOKEN: Record<string, ThemeToken> = {
  fail: "err",
  fix: "ok",
  why: "why",
  guard: "guard",
};

function whyTextOf(json: string): string | undefined {
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    const nested = raw.rationale;
    const text =
      (typeof nested === "object" && nested !== null ? (nested as { text?: unknown }).text : undefined) ??
      raw.reason ??
      (typeof nested === "string" ? nested : undefined) ??
      raw.excerpt ??
      raw.note;
    return typeof text === "string" && text.trim() !== "" ? text : undefined;
  } catch {
    return undefined;
  }
}

export class BrowseOverlayNode extends Node {
  constructor(
    readonly state: ShellState,
    readonly frame: number,
    readonly ascii: boolean,
    readonly motionOn: boolean = true,
  ) {
    super();
  }

  override paint(buf: CellBuffer): void {
    const { x, y, w, h } = this.rect;
    if (w <= 0 || h <= 0) return;

    const rows = browseVisible(this.state);
    const inner = paintBox(buf, this.rect, `browse · ${rows.length}`, true, this.ascii);

    buf.blitText(inner.x, inner.y, "›", "accent");
    const qText = this.state.bquery || "type to filter…";
    buf.blitText(inner.x + 2, inner.y, qText, this.state.bquery ? "text" : "muted");
    if (pulse(this.frame, this.motionOn)) {
      const qx = inner.x + 2 + (this.state.bquery ? stringWidth(this.state.bquery) : 0);
      buf.blitText(qx, inner.y, "▏", "accent", { x: inner.x, y: inner.y, w: inner.w, h: 1 });
    }

    const bodyTop = inner.y + 2;
    const bodyH = Math.max(1, inner.h - 4);
    const listW = Math.max(8, Math.floor(inner.w * 0.45));
    const listRect: Rect = { x: inner.x, y: bodyTop, w: listW, h: bodyH };
    this.state.brects = listRect;

    if (this.state.bsel < this.state.btop) this.state.btop = this.state.bsel;
    if (this.state.bsel >= this.state.btop + listRect.h) {
      this.state.btop = this.state.bsel - listRect.h + 1;
    }

    for (let i = 0; i < listRect.h; i++) {
      const row = rows[this.state.btop + i];
      if (!row) break;
      const yy = listRect.y + i;
      const on = this.state.btop + i === this.state.bsel;
      if (on) {
        buf.set(listRect.x - 1, yy, "▎", "accent");
      }
      let lx = listRect.x;
      lx += buf.blitText(lx, yy, row.badge.padEnd(5), on ? LIST_TOKEN[row.badge] ?? "why" : "muted") + 1;
      buf.blitText(lx, yy, cut(row.label, Math.max(0, listRect.w - (lx - listRect.x))), on ? "text" : "text2");
    }
    if (rows.length === 0) {
      buf.blitText(listRect.x, listRect.y, "no records match.", "muted");
    }

    const prevX = listRect.x + listRect.w + 2;
    const prevW = Math.max(0, inner.x + inner.w - prevX);
    const sel = rows[Math.min(this.state.bsel, Math.max(0, rows.length - 1))];
    if (sel && prevW > 8) {
      const token = LIST_TOKEN[sel.badge] ?? "why";
      buf.blitText(prevX, bodyTop, sel.kind, token);
      buf.blitText(prevX, bodyTop + 1, stamp(sel.ts), "muted");
      let py = bodyTop + 3;
      for (const wrapped of wrapToWidth(sel.label, prevW)) {
        if (py >= bodyTop + bodyH) break;
        buf.blitText(prevX, py++, wrapped, "text");
      }
      const why = whyTextOf(sel.json);
      if (why && py < bodyTop + bodyH - 1) {
        py++;
        for (const wrapped of wrapToWidth(why, prevW)) {
          if (py >= bodyTop + bodyH) break;
          buf.blitText(prevX, py++, wrapped, "text2");
        }
      }
    }

    buf.blitText(
      inner.x,
      inner.y + inner.h - 1,
      "[type] filter  [↑↓] pick  [enter] act  [esc] close",
      "muted",
      { x: inner.x, y: inner.y + inner.h - 1, w: inner.w, h: 1 },
    );
  }
}

export function surfaceRoot(
  state: ShellState,
  size: { cols: number; rows: number },
  frame: number,
  ascii: boolean,
  homeData?: HomeData,
  motionOn?: boolean,
  now?: number,
): Node {
  const clock = now ?? Date.now();
  const snapshot = homeData ? undefined : getMemorySnapshot();
  const data =
    homeData ??
    deriveHome(snapshot?.records ?? [], snapshot?.coverageReason, clock);

  if (state.view === "compare") {
    const comp = state.compare ?? initialCompareState(snapshot?.records ?? []);
    return compareView(comp, size, frame, ascii, snapshot?.records ?? comp.records, motionOn, clock);
  }

  const mainCol = new Node({ direction: "column", grow: 1 });
  const mood = shellMood(state);

  // 1. Header
  if (state.view === "home" && !ascii) {
    const headerZone = new Node({ direction: "row", height: 5 });
    const titleCol = new Node({ direction: "column", grow: 1 });
    titleCol.add(new TextNode(` ROCKY  ${data.total} remembered`, "accent", { height: 1 }));
    headerZone.add(titleCol);
    headerZone.add(new CarapaceNode(mood, frame, ascii, motionOn ?? true, { width: 16, height: 5 }));
    mainCol.add(headerZone);
  } else {
    mainCol.add(new TextNode(` ROCKY  ${data.total} remembered`, "accent", { height: 1 }));
  }

  // 2. Middle view (home vs stream)
  const middle =
    state.view === "home"
      ? homeView(data, size, ascii)
      : streamView(state.cards, state.scroll, size);
  mainCol.add(middle);

  // 3. Input line
  const cwdTail = state.cwd.replace(/\\/g, "/").split("/").filter(Boolean).slice(-2).join("/");
  const inputLine = new InputLineNode(
    {
      value: state.input,
      placeholder: "/run npm test · /recall query · /help",
      cwdTail,
      frame,
      motionOn: true,
      ascii,
    },
    { height: 3 },
  );
  mainCol.add(inputLine);

  // 4. Status bar
  const segments: Array<[string, string]> =
    state.view === "home"
      ? [
          ["type", "command"],
          ["tab", "complete"],
          ["enter", "run"],
          ["^c", "quit"],
        ]
      : [
          ["esc", "home"],
          ["^u/^d", "scroll"],
          ["tab", "complete"],
          ["^c", "quit"],
        ];
  const statusBar = new StatusBarNode(segments, "local only · no egress", { height: 1 });
  mainCol.add(statusBar);

  // 5. Slash menu overlay (painted last)
  let slashMenu: SlashMenuNode | undefined;
  if (state.input.startsWith("/") && !state.input.includes(" ")) {
    const cleanPrefix = state.input.slice(1);
    const matches = matchCommands(cleanPrefix);
    if (matches.length > 0) {
      slashMenu = new SlashMenuNode({ prefix: state.input, selected: state.csel, ascii });
    }
  }

  // 6. Browse overlay (painted above everything)
  const browseOverlay =
    state.overlay === "browse" ? new BrowseOverlayNode(state, frame, ascii, motionOn ?? true) : undefined;

  return new SurfaceRootNode(mainCol, slashMenu, browseOverlay);
}

