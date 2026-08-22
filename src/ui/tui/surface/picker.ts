import type { CompareRec } from "./compare-data.js";
import type { Key } from "../state.js";

export interface PickerState {
  open: boolean;
  markA: boolean;
  recA?: CompareRec;
  recB?: CompareRec;
  tsel: number;
  tquery: string;
}

export interface SessionItem {
  hdr?: number;
  ts?: number;
  n?: number;
  rec?: CompareRec;
  idx?: number;
}

/** Rocky's own session rule — a 30-minute gap starts a new one — over one file's records. */
export function sessionItems(list: CompareRec[]): SessionItem[] {
  const items: SessionItem[] = [];
  let last: number | null = null;
  let si = 0;
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (last === null || last - r.ts > 30 * 60 * 1000) {
      si++;
      let n = 1;
      let t = r.ts;
      for (let j = i + 1; j < list.length && t - list[j].ts <= 30 * 60 * 1000; j++) {
        t = list[j].ts;
        n++;
      }
      items.push({ hdr: si, ts: r.ts, n });
    }
    items.push({ rec: r, idx: i });
    last = r.ts;
  }
  return items;
}

/** Pick-modal list: intent-only search; agent envelopes match on their summary. */
export function pickList(recs: CompareRec[], st: PickerState): CompareRec[] {
  // A locked: it leaves the menu; the left pane is already wearing it
  const list = st.markA && st.recA ? recs.filter((r) => r !== st.recA) : recs;
  if (!st.tquery) return list;
  const q = st.tquery.toLowerCase();
  return list.filter((r) => {
    const t = r.machine ? (r.summary ?? "") : (r.intent ?? "");
    return t.toLowerCase().includes(q);
  });
}

/** Live preview of the pending pick pair: cursor is candidate */
export function previewPair(st: PickerState, recs: CompareRec[]): { a?: CompareRec; b?: CompareRec } {
  const list = pickList(recs, st);
  const cur = list.length > 0 ? list[Math.max(0, Math.min(st.tsel, list.length - 1))] : undefined;
  if (st.markA && st.recA) {
    return { a: st.recA, b: cur };
  }
  return { a: cur, b: undefined };
}

/** Pure reducer for timeline picker navigation and selection */
export function updatePicker(st: PickerState, recs: CompareRec[], key: Key): PickerState {
  if (key.name === "esc") {
    if (st.tquery) {
      return { ...st, tquery: "", tsel: 0 };
    }
    if (st.markA) {
      return { ...st, markA: false, recA: undefined, recB: undefined, tsel: 0 };
    }
    return { ...st, open: false };
  }

  if (key.name === "up") {
    return { ...st, tsel: Math.max(0, st.tsel - 1) };
  }

  if (key.name === "down") {
    const list = pickList(recs, st);
    return { ...st, tsel: Math.min(Math.max(0, list.length - 1), st.tsel + 1) };
  }

  if (key.name === "left" || key.name === "right") {
    const list = pickList(recs, st);
    const items = sessionItems(list);
    const starts: number[] = [];
    for (let i = 0; i < items.length - 1; i++) {
      if (items[i].hdr !== undefined && items[i + 1].idx !== undefined) {
        starts.push(items[i + 1].idx!);
      }
    }
    if (starts.length === 0) return st;
    const cur = Math.max(0, starts.filter((s) => s <= st.tsel).length - 1);
    const nxt = key.name === "right" ? Math.min(starts.length - 1, cur + 1) : Math.max(0, cur - 1);
    return { ...st, tsel: starts[nxt] };
  }

  if (key.name === "backspace") {
    return { ...st, tquery: st.tquery.slice(0, -1), tsel: 0 };
  }

  if (key.name === "char") {
    return { ...st, tquery: st.tquery + key.ch, tsel: 0 };
  }

  if (key.name === "paste") {
    return { ...st, tquery: st.tquery + key.text, tsel: 0 };
  }

  if (key.name === "enter") {
    const list = pickList(recs, st);
    const curIdx = Math.max(0, Math.min(st.tsel, list.length - 1));
    const rec = list[curIdx];
    if (!rec) return st;
    if (!st.markA) {
      const idxInFull = recs.indexOf(rec);
      return {
        ...st,
        markA: true,
        recA: rec,
        tquery: "",
        tsel: Math.max(0, idxInFull - 1),
      };
    } else {
      return {
        ...st,
        open: false,
        recB: rec,
        tquery: "",
      };
    }
  }

  return st;
}
