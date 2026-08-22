import { BoxNode } from "../components/box.js";
import { Node, TextNode, type NodeProps } from "../core/node.js";
import type { ThemeToken } from "../theme.js";
import { deriveHome, type HomeData } from "./home-data.js";
import type { Card } from "../cards/card.js";
import { wrapToWidth, stringWidth } from "../core/text.js";
import { CellBuffer, type Rect } from "../core/buffer.js";
import { InputLineNode, StatusBarNode, SlashMenuNode } from "../components/chrome.js";
import { matchCommands } from "./registry.js";
import { getMemorySnapshot, type ShellState } from "./shell.js";

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
  constructor(readonly mainColumn: Node, slashNode?: SlashMenuNode) {
    super({ direction: "column" });
    this.add(mainColumn);
    if (slashNode) {
      this.slashNode = slashNode;
      this.add(slashNode);
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
  }
}

export function surfaceRoot(
  state: ShellState,
  size: { cols: number; rows: number },
  frame: number,
  ascii: boolean,
  homeData?: HomeData,
): Node {
  const snapshot = homeData ? undefined : getMemorySnapshot();
  const data =
    homeData ??
    deriveHome(snapshot?.records ?? [], snapshot?.coverageReason, Date.now());

  const mainCol = new Node({ direction: "column", grow: 1 });

  // 1. Header
  const header = new TextNode(` ROCKY  ${data.total} remembered`, "accent", { height: 1 });
  mainCol.add(header);

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
      slashMenu = new SlashMenuNode({ prefix: state.input, selected: state.csel });
    }
  }

  return new SurfaceRootNode(mainCol, slashMenu);
}
