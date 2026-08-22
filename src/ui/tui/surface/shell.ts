import { homedir } from "node:os";
import { existsSync } from "node:fs";
import type { Card } from "../cards/card.js";
import {
  buildRecall,
  buildWhy,
  buildSessions,
  buildStats,
  buildBrief,
  buildRun,
  buildHelp,
  buildYou,
  buildError,
  type EvidenceHit,
} from "../cards/build.js";
import { COMMANDS, matchCommands, parseInput } from "./registry.js";
import { interceptCd, spawnRun, type RunOutcome } from "./runcmd.js";
import { Live } from "../core/live.js";
import { surfaceRoot } from "./views.js";
import { motionEnabled } from "../core/motion.js";
import type { Rect } from "../core/buffer.js";
import type { MouseEvent } from "../core/mouse.js";
import { loadMemoryChecked, type MemoryRecord } from "../../../core/memory-read.js";
import { resolveRockyPaths } from "../../../core/state-paths.js";
import { adaptHit } from "./home-data.js";
import { tokens, similarity } from "../../../core/fingerprint.js";
import { elapsed } from "../../rocky.js";
import { loadDashRows, searchRows } from "../data.js";
import type { DashRow } from "../state.js";
import { moodFor, type Mood } from "../components/carapace.js";
import type { Key } from "../state.js";
import type { PickerState } from "./picker.js";
import { updatePicker, previewPair } from "./picker.js";
import { type CompareRec, type FileEntry, fileIndex } from "./compare-data.js";

export type CompareFocus = "files" | "compare" | "recA" | "recB" | "diffA" | "diffB";
export type CompareModal = "scope" | "timeline" | null;
export type CompareMode = "all" | "two" | null;

export interface CompareState {
  records: MemoryRecord[];
  files: FileEntry[];
  fquery: string;
  fsel: number;
  ftop: number;
  focus: CompareFocus;
  modal: CompareModal;
  msel: number;
  picker: PickerState;
  file: FileEntry | null;
  mode: CompareMode;
  A: number | null;
  B: number | null;
  recA: CompareRec | null;
  recB: CompareRec | null;
  expA: boolean;
  expB: boolean;
  cscroll: number;
  dscrollA: number;
  dscrollB: number;
  hscrollA: number;
  hscrollB: number;
  showDiff: boolean;
  zoom: boolean;
  rects?: Partial<Record<CompareFocus, Rect>>;
}

export interface ShellState {
  view: "home" | "stream" | "compare";
  input: string;
  csel: number;
  scroll: number;
  cwd: string;
  cards: Card[];
  quit: boolean;
  pendingRun?: string;
  compare?: CompareState;
  overlay?: "browse";
  brows: DashRow[];
  bsel: number;
  bquery: string;
  btop: number;
  brects?: Rect;
}

export type ShellEvent =
  | { type: "key"; key: Key }
  | { type: "card"; card: Card }
  | { type: "cd"; next: string };

export function initialCompareState(records: MemoryRecord[] = []): CompareState {
  const files = fileIndex(records);
  return {
    records,
    files,
    fquery: "",
    fsel: 0,
    ftop: 0,
    focus: "files",
    modal: null,
    msel: 0,
    picker: { open: false, markA: false, tsel: 0, tquery: "" },
    file: null,
    mode: null,
    A: null,
    B: null,
    recA: null,
    recB: null,
    expA: false,
    expB: false,
    cscroll: 0,
    dscrollA: 0,
    dscrollB: 0,
    hscrollA: 0,
    hscrollB: 0,
    showDiff: true,
    zoom: false,
    rects: {},
  };
}

export function compareFocusables(state: CompareState): CompareFocus[] {
  const f: CompareFocus[] = ["files"];
  if (state.file && state.mode === "two") {
    f.push("recA", "recB");
    if (state.showDiff) f.push("diffA", "diffB");
  } else if (state.file) {
    f.push("compare");
    if (state.showDiff) f.push("diffA");
  }
  return f;
}

export function filteredFiles(state: CompareState): FileEntry[] {
  if (!state.fquery) return state.files;
  const q = state.fquery.toLowerCase();
  return state.files.filter((f) => f.path.toLowerCase().includes(q));
}

export function scrollComparePane(state: CompareState, focus: CompareFocus, delta: number): CompareState {
  if (focus === "files") {
    const list = filteredFiles(state);
    const maxIdx = Math.max(0, list.length - 1);
    return { ...state, fsel: Math.max(0, Math.min(maxIdx, state.fsel + delta)) };
  }
  if (focus === "diffA") {
    return { ...state, dscrollA: Math.max(0, state.dscrollA + delta) };
  }
  if (focus === "diffB") {
    return { ...state, dscrollB: Math.max(0, state.dscrollB + delta) };
  }
  return { ...state, cscroll: Math.max(0, state.cscroll + delta) };
}

export function comparePaneAt(rects: CompareState["rects"], x: number, y: number): CompareFocus | null {
  for (const k of ["files", "diffA", "diffB", "recA", "recB", "compare"] as CompareFocus[]) {
    const r = rects?.[k];
    if (!r) continue;
    if (x >= r.x - 2 && x < r.x + r.w + 2 && y >= r.y - 1 && y < r.y + r.h + 1) return k;
  }
  return null;
}

export function applyMouseToCompare(state: CompareState, ev: MouseEvent): CompareState {
  if (ev.kind === "wheel-up" || ev.kind === "wheel-down") {
    if (state.modal) {
      return updateCompareState(state, ev.kind === "wheel-up" ? { name: "up" } : { name: "down" });
    }
    const target = comparePaneAt(state.rects, ev.x, ev.y);
    return scrollComparePane(state, target ?? state.focus, ev.kind === "wheel-up" ? -3 : 3);
  }
  if (ev.kind !== "press" || state.modal) return state;
  const target = comparePaneAt(state.rects, ev.x, ev.y);
  if (!target) return state;
  return { ...state, focus: target };
}

export function updateCompareState(state: CompareState, key: Key): CompareState {
  if (state.modal === "scope") {
    if (key.name === "esc") {
      return { ...state, modal: null };
    }
    if (key.name === "up" || (key.name === "char" && key.ch === "k")) {
      return { ...state, msel: Math.max(0, state.msel - 1) };
    }
    if (key.name === "down" || (key.name === "char" && key.ch === "j")) {
      return { ...state, msel: Math.min(1, state.msel + 1) };
    }
    if (key.name === "enter") {
      if (state.msel === 0) {
        return { ...state, mode: "all", modal: null, cscroll: 0, focus: "compare" };
      } else {
        const fileRecs = state.file?.recs ?? [];
        return {
          ...state,
          modal: "timeline",
          mode: "two",
          picker: { open: true, markA: false, tsel: 0, tquery: "" },
          recA: null,
          recB: null,
          A: null,
          B: null,
          cscroll: 0,
          dscrollA: 0,
          dscrollB: 0,
          hscrollA: 0,
          hscrollB: 0,
          expA: false,
          expB: false,
        };
      }
    }
    return state;
  }

  if (state.modal === "timeline") {
    const fileRecs = state.file?.recs ?? [];
    const nextPicker = updatePicker(state.picker, fileRecs, key);
    if (!nextPicker.open) {
      if (nextPicker.recB) {
        const recA = nextPicker.recA ?? state.recA;
        const recB = nextPicker.recB;
        return {
          ...state,
          modal: null,
          picker: nextPicker,
          recA,
          recB,
          A: recA?.ts ?? null,
          B: recB.ts,
          cscroll: 0,
          dscrollA: 0,
          dscrollB: 0,
          hscrollA: 0,
          hscrollB: 0,
          expA: false,
          expB: false,
          focus: "recB",
        };
      } else {
        return {
          ...state,
          modal: "scope",
          picker: nextPicker,
          mode: null,
          recA: null,
          recB: null,
          A: null,
          B: null,
        };
      }
    } else {
      const pair = previewPair(nextPicker, fileRecs);
      return {
        ...state,
        picker: nextPicker,
        recA: pair.a ?? null,
        recB: pair.b ?? null,
        A: pair.a?.ts ?? null,
        B: pair.b?.ts ?? null,
      };
    }
  }

  if (key.name === "tab" || key.name === "shifttab") {
    const focusList = compareFocusables(state);
    const curIdx = focusList.indexOf(state.focus);
    const delta = key.name === "shifttab" ? focusList.length - 1 : 1;
    const nextFocus = focusList[(curIdx + delta) % focusList.length];
    return { ...state, focus: nextFocus };
  }

  if (key.name === "esc") {
    if (state.zoom) {
      return { ...state, zoom: false };
    }
    if (state.file) {
      return {
        ...state,
        file: null,
        mode: null,
        recA: null,
        recB: null,
        A: null,
        B: null,
        focus: "files",
      };
    }
    return state;
  }

  if (state.focus === "files") {
    if (key.name === "enter") {
      const list = filteredFiles(state);
      const selFile = list[state.fsel];
      if (selFile) {
        return { ...state, file: selFile, modal: "scope", msel: 0 };
      }
      return state;
    }
    if (key.name === "up") {
      return { ...state, fsel: Math.max(0, state.fsel - 1) };
    }
    if (key.name === "down") {
      const list = filteredFiles(state);
      return { ...state, fsel: Math.min(Math.max(0, list.length - 1), state.fsel + 1) };
    }
    if (key.name === "backspace") {
      return { ...state, fquery: state.fquery.slice(0, -1), fsel: 0, ftop: 0 };
    }
    if (key.name === "char") {
      return { ...state, fquery: state.fquery + key.ch, fsel: 0, ftop: 0 };
    }
    if (key.name === "paste") {
      return { ...state, fquery: state.fquery + key.text, fsel: 0, ftop: 0 };
    }
    return state;
  }

  if (key.name === "up" || (key.name === "char" && key.ch === "k")) {
    return scrollComparePane(state, state.focus, -1);
  }
  if (key.name === "down" || (key.name === "char" && key.ch === "j")) {
    return scrollComparePane(state, state.focus, 1);
  }
  if (key.name === "ctrl-u" || (key.name === "char" && key.ch === "K")) {
    return scrollComparePane(state, state.focus, -5);
  }
  if (key.name === "ctrl-d" || (key.name === "char" && key.ch === "J")) {
    return scrollComparePane(state, state.focus, 5);
  }

  if (state.focus === "diffA" || state.focus === "diffB") {
    const hk = state.focus === "diffA" ? "hscrollA" : "hscrollB";
    if (key.name === "char" && key.ch === "l") {
      return { ...state, [hk]: state[hk] + 8 };
    }
    if (key.name === "right") {
      return { ...state, [hk]: state[hk] + 8 };
    }
    if (key.name === "char" && key.ch === "h") {
      return { ...state, [hk]: Math.max(0, state[hk] - 8) };
    }
    if (key.name === "left") {
      return { ...state, [hk]: Math.max(0, state[hk] - 8) };
    }
    if (key.name === "char" && key.ch === "L") {
      return { ...state, [hk]: state[hk] + 24 };
    }
    if (key.name === "char" && key.ch === "H") {
      return { ...state, [hk]: Math.max(0, state[hk] - 24) };
    }
    if (key.name === "char" && key.ch === "0") {
      return { ...state, [hk]: 0 };
    }
  }

  if (key.name === "char" && key.ch === "d") {
    if (state.file && state.mode) {
      const nextShow = !state.showDiff;
      let nextFocus = state.focus;
      if (!nextShow && (state.focus === "diffA" || state.focus === "diffB")) {
        nextFocus = state.mode === "two" ? "recA" : "compare";
      }
      return { ...state, showDiff: nextShow, dscrollA: 0, dscrollB: 0, focus: nextFocus };
    }
  }

  if (key.name === "char" && key.ch === "z") {
    return { ...state, zoom: !state.zoom };
  }

  if (key.name === "char" && key.ch === "x") {
    if (state.focus === "recA") return { ...state, expA: !state.expA };
    if (state.focus === "recB") return { ...state, expB: !state.expB };
  }

  if (key.name === "char" && key.ch === "/") {
    return { ...state, focus: "files" };
  }

  if (key.name === "enter") {
    if (state.file) {
      return { ...state, modal: "scope", msel: 0 };
    }
  }

  return state;
}

export function initialShell(cwd: string): ShellState {
  const snapshot = getMemorySnapshot();
  return {
    view: "home",
    input: "",
    csel: 0,
    scroll: 0,
    cwd,
    cards: [],
    quit: false,
    pendingRun: undefined,
    compare: initialCompareState(snapshot.records),
    overlay: undefined,
    brows: [],
    bsel: 0,
    bquery: "",
    btop: 0,
    brects: undefined,
  };
}

export function browseVisible(state: Pick<ShellState, "brows" | "bquery">): DashRow[] {
  return searchRows(state.brows, state.bquery);
}

export function applyMouseToBrowse(state: ShellState, ev: MouseEvent): ShellState {
  const max = Math.max(0, browseVisible(state).length - 1);
  if (ev.kind === "wheel-up") return { ...state, bsel: Math.max(0, state.bsel - 3) };
  if (ev.kind === "wheel-down") return { ...state, bsel: Math.min(max, state.bsel + 3) };
  if (ev.kind !== "press") return state;
  const r = state.brects;
  if (!r || ev.y < r.y || ev.y >= r.y + r.h) return state;
  const idx = state.btop + (ev.y - r.y);
  if (idx < 0 || idx > max) return state;
  return { ...state, bsel: idx };
}

export function updateBrowseState(state: ShellState, key: Key): ShellState {
  const visible = browseVisible(state);
  const max = Math.max(0, visible.length - 1);
  if (key.name === "esc") {
    return { ...state, overlay: undefined, bquery: "", bsel: 0, btop: 0, brects: undefined };
  }
  if (key.name === "up") {
    return { ...state, bsel: Math.max(0, state.bsel - 1) };
  }
  if (key.name === "down") {
    return { ...state, bsel: Math.min(max, state.bsel + 1) };
  }
  if (key.name === "ctrl-u") {
    return { ...state, bsel: Math.max(0, state.bsel - 5) };
  }
  if (key.name === "ctrl-d") {
    return { ...state, bsel: Math.min(max, state.bsel + 5) };
  }
  if (key.name === "backspace") {
    return { ...state, bquery: state.bquery.slice(0, -1), bsel: 0 };
  }
  if (key.name === "paste") {
    return { ...state, bquery: (state.bquery + key.text).slice(0, 120), bsel: 0 };
  }
  if (key.name === "char") {
    return { ...state, bquery: (state.bquery + key.ch).slice(0, 120), bsel: 0 };
  }
  if (key.name === "enter") {
    const closed: ShellState = {
      ...state,
      overlay: undefined,
      bquery: "",
      bsel: 0,
      btop: 0,
      brects: undefined,
    };
    const row = visible[Math.min(state.bsel, max)];
    if (!row) return closed;
    return {
      ...closed,
      input: browsePrefill(row),
      csel: 0,
      view: "stream",
      scroll: 0,
    };
  }
  return state;
}

function browsePrefill(row: DashRow): string {
  let file: string | undefined;
  try {
    const raw = JSON.parse(row.json) as Record<string, unknown>;
    const candidates = [
      raw.file,
      raw.path,
      (raw.mechanism as { files?: Array<{ path?: unknown }> } | undefined)?.files?.[0]?.path,
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c !== "") {
        file = c;
        break;
      }
    }
  } catch {
    file = undefined;
  }
  if (file) return `why ${file}`;
  const words = row.label.split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
  return words !== "" ? `recall ${words}` : "recall ";
}

export function shellMood(s: Pick<ShellState, "cards" | "input" | "pendingRun">): Mood {
  return moodFor({
    runningCount:
      s.cards.filter((c) => c.kind === "run" && c.meta === "running…").length +
      (s.pendingRun !== undefined ? 1 : 0),
    lastCard: s.cards[s.cards.length - 1],
    typing: s.input !== "",
  });
}

export interface AnswerSnapshot {
  records: MemoryRecord[];
  coverageReason?: string;
}

export function getMemorySnapshot(
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): AnswerSnapshot {
  try {
    const paths = resolveRockyPaths(env);
    const loaded = loadMemoryChecked(paths.memory, now);
    return { records: loaded.records, coverageReason: loaded.coverage.reason };
  } catch {
    return { records: [], coverageReason: undefined };
  }
}

function handleRecall(query: string, records: MemoryRecord[], now: number): Card {
  const qTokens = tokens(query);
  const hits: Array<{ hit: EvidenceHit; score: number; ts: number }> = [];

  for (const r of records) {
    const adapted = adaptHit(r, now);
    const score = similarity(qTokens, tokens(adapted.label));
    if (score > 0) {
      hits.push({
        hit: {
          label: adapted.label,
          agoText: adapted.agoText,
          source: (r as any).source ?? (r as any).agent ?? (adapted.machine ? "agent" : "hook"),
          machine: adapted.machine,
        },
        score,
        ts: r.ts ?? 0,
      });
    }
  }

  hits.sort((a, b) => b.score - a.score || b.ts - a.ts);
  const topHits = hits.slice(0, 6).map((h) => h.hit);
  return buildRecall(query, topHits);
}

function handleWhy(query: string, records: MemoryRecord[], now: number): Card {
  const qTokens = query === "why" ? new Set<string>() : tokens(query);
  const results: Array<{ text: string; source: string; agoText: string; score: number; ts: number }> = [];

  for (const r of records) {
    const raw = r as unknown as Record<string, unknown>;
    const reasonText =
      (typeof raw.rationale === "object" && raw.rationale !== null
        ? (raw.rationale as { text?: string }).text
        : undefined) ??
      (typeof raw.rationale === "string" ? raw.rationale : undefined) ??
      (typeof raw.excerpt === "string" ? raw.excerpt : undefined) ??
      (typeof raw.note === "string" ? raw.note : undefined);

    if (!reasonText || reasonText.trim() === "") continue;

    const adapted = adaptHit(r, now);
    const score = qTokens.size === 0 ? 1 : similarity(qTokens, tokens(`${adapted.label} ${reasonText}`));
    if (qTokens.size === 0 || score > 0) {
      results.push({
        text: reasonText,
        source: (r as any).source ?? (r as any).agent ?? "rationale",
        agoText: adapted.agoText,
        score,
        ts: r.ts ?? 0,
      });
    }
  }

  results.sort((a, b) => b.score - a.score || b.ts - a.ts);
  const topResults = results.slice(0, 4).map((r) => ({
    text: r.text,
    source: r.source,
    agoText: r.agoText,
  }));
  return buildWhy(query, topResults);
}

function handleSessions(records: MemoryRecord[], now: number): Card {
  const groups: Array<{ cwd: string; start: number; end: number; count: number }> = [];
  let cur: { cwd: string; start: number; end: number; count: number } | null = null;

  const sorted = [...records].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  for (const r of sorted) {
    const ts = r.ts ?? 0;
    const cwd = (r as any).cwd || "(unknown)";
    if (cur && cur.cwd === cwd && ts - cur.end < 30 * 60 * 1000) {
      cur.end = ts;
      cur.count++;
      continue;
    }
    if (cur) groups.push(cur);
    cur = { cwd, start: ts, end: ts, count: 1 };
  }
  if (cur) groups.push(cur);

  const rows = groups
    .reverse()
    .slice(0, 6)
    .map((s, i) => {
      const tail = s.cwd.replace(/\\/g, "/").split("/").filter(Boolean).slice(-2).join("/");
      const span = elapsed(Math.max(0, now - s.end));
      const endedAgo = span === "just now" ? span : `${span} ago`;
      return {
        index: i + 1,
        cwdTail: tail || s.cwd,
        count: s.count,
        endedAgo,
      };
    });

  return buildSessions(rows);
}

function handleBrief(records: MemoryRecord[], now: number): Card {
  const dayWindowMs = 24 * 3600 * 1000;
  const dayRecords = records.filter((r) => {
    const ts = r.ts ?? 0;
    return typeof ts === "number" && now - ts < dayWindowMs && now - ts >= 0;
  });

  const heard = dayRecords.length;
  const failures = dayRecords.filter((r) => r.kind === "failure").length;
  const fixes = dayRecords.filter((r) => r.kind === "fix" || r.kind === "association").length;
  const whys = dayRecords.filter((r) => {
    if (r.kind === "triple" || r.kind === "rationale" || r.kind === "note") return true;
    if (typeof (r as any).rationale === "object" && (r as any).rationale !== null && (r as any).rationale.text) return true;
    return false;
  }).length;

  const sortedDay = [...dayRecords].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  const recentHits: EvidenceHit[] = sortedDay.slice(0, 5).map((r) => {
    const adapted = adaptHit(r, now);
    return {
      label: adapted.label,
      agoText: adapted.agoText,
      source: (r as any).source ?? (r as any).agent ?? (adapted.machine ? "agent" : "hook"),
      machine: adapted.machine,
    };
  });

  return buildBrief({ heard, failures, fixes, whys }, recentHits);
}

function handleStats(records: MemoryRecord[], now: number): Card {
  const kindCounts = new Map<string, number>();
  for (const r of records) {
    const k = r.kind || "unknown";
    kindCounts.set(k, (kindCounts.get(k) ?? 0) + 1);
  }
  const byKind = [...kindCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, count]) => ({ kind, count }));

  const total = records.length;
  let oldestAgo = "";
  if (total > 0) {
    const sorted = [...records].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    const oldestTs = sorted[0].ts ?? 0;
    const span = elapsed(Math.max(0, now - oldestTs));
    oldestAgo = span === "just now" ? span : `${span} ago`;
  }

  return buildStats(byKind, total, oldestAgo);
}

function submitInput(
  s: ShellState,
  rawInput: string,
  deps: { exists(p: string): boolean; home(): string },
): ShellState {
  const rawLine = rawInput.trim().replace(/^\//, "");
  if (!rawLine) return s;

  const { cmd, arg } = parseInput(rawInput);
  let nextState: ShellState = { ...s, input: "", csel: 0 };

  if (cmd === "home") {
    return { ...nextState, view: "home" };
  }
  if (cmd === "quit" || cmd === "exit") {
    return { ...nextState, quit: true };
  }

  // Push you card first
  const youCard = buildYou(rawLine);
  const newCards = [...nextState.cards, youCard];
  nextState = { ...nextState, cards: newCards, view: "stream", scroll: 0 };

  const snapshot = getMemorySnapshot();
  const now = Date.now();

  switch (cmd) {
    case "run": {
      if (!arg) {
        const errCard: Card = {
          kind: "run",
          accent: "err",
          subject: "",
          meta: "",
          facts: ["run", "run needs command. try: /run npm test"],
          lines: [{ text: "run needs command. try: /run npm test", token: "muted" }],
        };
        return { ...nextState, cards: [...nextState.cards, errCard] };
      }

      const cdOutcome = interceptCd(arg, nextState.cwd, deps);
      if (cdOutcome) {
        if ("next" in cdOutcome) {
          const cdCard: Card = {
            kind: "cd",
            accent: "ok",
            subject: cdOutcome.next,
            meta: "",
            facts: [cdOutcome.next, "rocky follows. next runs start here."],
            lines: [{ text: "rocky follows. next runs start here.", token: "muted" }],
          };
          return {
            ...nextState,
            cwd: cdOutcome.next,
            cards: [...nextState.cards, cdCard],
            pendingRun: undefined,
          };
        } else {
          const cdCard: Card = {
            kind: "cd",
            accent: "err",
            subject: cdOutcome.error,
            meta: "",
            facts: [cdOutcome.error, "path not there. rocky checks, finds nothing."],
            lines: [{ text: "path not there. rocky checks, finds nothing.", token: "muted" }],
          };
          return {
            ...nextState,
            cards: [...nextState.cards, cdCard],
            pendingRun: undefined,
          };
        }
      }

      // Normal command execution
      const runningCard: Card = {
        kind: "run",
        accent: "guard",
        subject: arg,
        meta: "running…",
        facts: [arg, "running…", "rocky listens…"],
        lines: [{ text: "rocky listens…", token: "muted" }],
      };
      return {
        ...nextState,
        cards: [...nextState.cards, runningCard],
        pendingRun: arg,
      };
    }
    case "recall":
    case "what":
    case "how": {
      const card = handleRecall(arg || cmd, snapshot.records, now);
      return { ...nextState, cards: [...nextState.cards, card] };
    }
    case "why": {
      const card = handleWhy(arg || "why", snapshot.records, now);
      return { ...nextState, cards: [...nextState.cards, card] };
    }
    case "sessions": {
      const card = handleSessions(snapshot.records, now);
      return { ...nextState, cards: [...nextState.cards, card] };
    }
    case "brief": {
      const card = handleBrief(snapshot.records, now);
      return { ...nextState, cards: [...nextState.cards, card] };
    }
    case "stats": {
      const card = handleStats(snapshot.records, now);
      return { ...nextState, cards: [...nextState.cards, card] };
    }
    case "compare": {
      const comp = s.compare ?? initialCompareState(snapshot.records);
      return {
        ...nextState,
        view: "compare",
        compare: {
          ...comp,
          records: snapshot.records,
          files: fileIndex(snapshot.records),
        },
      };
    }
    case "browse": {
      let brows: DashRow[] = [];
      try {
        brows = loadDashRows(resolveRockyPaths(process.env).memory, now).rows;
      } catch {
        brows = [];
      }
      return { ...nextState, overlay: "browse", brows, bsel: 0, bquery: "", btop: 0 };
    }
    case "help": {
      const card = buildHelp(COMMANDS);
      return { ...nextState, cards: [...nextState.cards, card] };
    }
    default: {
      const card = buildError(rawLine, COMMANDS);
      return { ...nextState, cards: [...nextState.cards, card] };
    }
  }
}

export function updateShell(
  s: ShellState,
  e: ShellEvent,
  deps: { exists(p: string): boolean; home(): string },
): ShellState {
  if (e.type === "cd") {
    return { ...s, cwd: e.next };
  }

  if (e.type === "card") {
    const card = e.card;
    if (card.kind === "run") {
      let lastRunningIndex = -1;
      for (let i = s.cards.length - 1; i >= 0; i--) {
        const c = s.cards[i];
        if (c.kind === "run" && c.subject === card.subject && c.meta === "running…") {
          lastRunningIndex = i;
          break;
        }
      }
      if (lastRunningIndex !== -1) {
        const nextCards = [...s.cards];
        nextCards[lastRunningIndex] = card;
        return { ...s, cards: nextCards, view: "stream", scroll: 0 };
      }
    }
    return { ...s, cards: [...s.cards, card], view: "stream", scroll: 0 };
  }

  const key = e.key;

  if (key.name === "ctrl-c") {
    return { ...s, quit: true };
  }

  if (s.overlay === "browse") {
    if (key.name === "mouse") {
      return applyMouseToBrowse(s, key.event);
    }
    return updateBrowseState(s, key);
  }

  if (s.view === "compare") {
    const currentCompare = s.compare ?? initialCompareState();
    if (key.name === "mouse") {
      return { ...s, compare: applyMouseToCompare(currentCompare, key.event) };
    }
    if (key.name === "esc" && !currentCompare.modal && !currentCompare.zoom && !currentCompare.file) {
      return { ...s, view: "home" };
    }
    const nextComp = updateCompareState(currentCompare, key);
    return { ...s, compare: nextComp };
  }

  const isMenuOpen = s.input.startsWith("/") && !s.input.includes(" ");
  const menuList = isMenuOpen ? matchCommands(s.input.slice(1)) : [];

  if (isMenuOpen && menuList.length > 0) {
    if (key.name === "up") {
      return { ...s, csel: Math.max(0, s.csel - 1) };
    }
    if (key.name === "down") {
      return { ...s, csel: Math.min(menuList.length - 1, s.csel + 1) };
    }
    if (key.name === "enter" || key.name === "tab") {
      const selIdx = Math.min(Math.max(0, s.csel), menuList.length - 1);
      const chosen = menuList[selIdx];
      if (chosen) {
        if (!chosen.takesArgs && key.name === "enter") {
          return submitInput(s, "/" + chosen.name, deps);
        } else {
          return { ...s, input: "/" + chosen.name + " ", csel: 0 };
        }
      }
    }
    if (key.name === "esc") {
      return { ...s, input: "", csel: 0 };
    }
  }

  if (key.name === "esc") {
    if (s.input !== "") {
      return { ...s, input: "", csel: 0 };
    }
    if (s.view === "stream") {
      return { ...s, view: "home" };
    }
    return s;
  }

  if (key.name === "enter") {
    return submitInput(s, s.input, deps);
  }

  if (key.name === "backspace") {
    return { ...s, input: s.input.slice(0, -1), csel: 0 };
  }

  if (key.name === "tab") {
    const base = s.input.replace(/^\//, "");
    const m = COMMANDS.find((c) => c.name.startsWith(base));
    if (m) {
      return { ...s, input: (s.input.startsWith("/") ? "/" : "") + m.name + " ", csel: 0 };
    }
    return s;
  }

  if (key.name === "ctrl-u") {
    return { ...s, scroll: s.scroll + 8 };
  }
  if (key.name === "ctrl-d") {
    return { ...s, scroll: Math.max(0, s.scroll - 8) };
  }
  if (key.name === "up") {
    return { ...s, scroll: s.scroll + 1 };
  }
  if (key.name === "down") {
    return { ...s, scroll: Math.max(0, s.scroll - 1) };
  }

  if (key.name === "char") {
    return { ...s, input: s.input + key.ch, csel: 0 };
  }
  if (key.name === "paste") {
    return { ...s, input: s.input + key.text, csel: 0 };
  }

  return s;
}

/** A surface that starts with an overlay already open (dash → browse). */
export interface InitialOverlay {
  kind: "browse";
  /** Seed the browse filter, so `rocky dash <query>` keeps its meaning. */
  query?: string;
}

export function runSurface(opts: {
  stdout: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
  env: NodeJS.ProcessEnv;
  view?: "home" | "stream" | "compare";
  initialOverlay?: InitialOverlay;
}): Promise<number> {
  let state = initialShell(process.cwd());
  if (opts.view) {
    state = { ...state, view: opts.view };
  }
  if (opts.initialOverlay?.kind === "browse") {
    let brows: DashRow[] = [];
    try {
      brows = loadDashRows(resolveRockyPaths(opts.env).memory, Date.now()).rows;
    } catch {
      brows = [];
    }
    state = {
      ...state,
      overlay: "browse",
      brows,
      bsel: 0,
      bquery: opts.initialOverlay.query ?? "",
      btop: 0,
    };
  }
  const ascii = opts.env.ROCKY_ASCII === "1" || opts.env.TERM === "dumb";
  const live = new Live({ stdout: opts.stdout, stdin: opts.stdin, env: opts.env });
  const deps = { exists: existsSync, home: homedir };

  return new Promise<number>((resolve) => {
    const dispatch = (event: ShellEvent): void => {
      state = updateShell(state, event, deps);
      if (state.quit) {
        live.stop();
        resolve(0);
        return;
      }
      if (state.pendingRun !== undefined) {
        const cmdToRun = state.pendingRun;
        state = { ...state, pendingRun: undefined };
        spawnRun(cmdToRun, state.cwd, (outcome: RunOutcome) => {
          dispatch({ type: "card", card: buildRun(cmdToRun, outcome) });
        });
      }
      live.requestFrame();
    };

    live.setRoot((sz) => surfaceRoot(state, sz, live.frame, ascii, undefined, motionEnabled(opts.env)));
    live.onKey((k) => {
      dispatch({ type: "key", key: k });
    });
    live.start();
  });
}

