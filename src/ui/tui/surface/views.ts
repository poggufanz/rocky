import { BoxNode } from "../components/box.js";
import { Node, TextNode } from "../core/node.js";
import type { ThemeToken } from "../theme.js";
import type { HomeData } from "./home-data.js";

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
