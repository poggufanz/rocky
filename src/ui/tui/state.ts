import { searchRows } from "./data.js";
import { MouseEvent } from "./core/mouse.js";

export type PaneId = "list" | "inspector";
export type TabId = "info" | "rationale" | "diff" | "json";
export type FilterId = "all" | "failures" | "triples" | "sessions" | "invariants";
export type BadgeId = "fail" | "fix" | "why" | "guard";

export interface DashRow {
  id: string;
  badge: BadgeId;
  label: string;
  ts: number;
  kind: string;
  json: string;
}

export type Key =
  | { name: "char"; ch: string }
  | {
      name:
        | "up"
        | "down"
        | "left"
        | "right"
        | "tab"
        | "shifttab"
        | "enter"
        | "esc"
        | "backspace"
        | "ctrl-c"
        | "ctrl-d"
        | "ctrl-u"
        | "ctrl-z";
    }
  | { name: "paste"; text: string }
  | { name: "mouse"; event: MouseEvent };

export interface DashState {
  cols: number;
  rows: number;
  stacked: boolean;
  focus: PaneId;
  inspectorOpen: boolean;
  allRows: DashRow[];
  selected: number;
  filter: FilterId;
  search: { active: boolean; query: string };
  tab: TabId;
  help: boolean;
  fullDiff: boolean;
  coverageLine: string;
  quit: boolean;
  reloadRequested: boolean;
  diff: {
    state: "idle" | "loading" | "ready" | "unavailable";
    rowId?: string;
    lines: string[];
  };
  scroll: { inspector: number };
  wrap: boolean;
}

export type DashEvent =
  | { type: "key"; key: Key }
  | { type: "resize"; cols: number; rows: number }
  | { type: "data"; rows: DashRow[]; coverageLine: string }
  | { type: "diff-loading"; rowId: string }
  | { type: "diff-ready"; rowId: string; lines: string[] };

const FILTER_ORDER: FilterId[] = ["all", "failures", "triples", "sessions", "invariants"];

const FILTER_KINDS: Record<FilterId, (kind: string) => boolean> = {
  all: () => true,
  failures: (k) => k === "failure" || k === "fix",
  triples: (k) => k === "triple" || k === "rationale" || k === "note",
  sessions: (k) => k === "brief_run",
  invariants: (k) => k === "invariant_touch",
};

export function initialState(cols: number, rows: number): DashState {
  return {
    cols,
    rows,
    stacked: cols < 80 || rows < 20,
    focus: "list",
    inspectorOpen: false,
    allRows: [],
    selected: 0,
    filter: "all",
    search: { active: false, query: "" },
    tab: "info",
    help: false,
    fullDiff: false,
    coverageLine: "",
    quit: false,
    reloadRequested: false,
    diff: { state: "idle", lines: [] },
    scroll: { inspector: 0 },
    wrap: true,
  };
}

export function visibleRows(state: DashState): DashRow[] {
  const matcher = FILTER_KINDS[state.filter] ?? (() => true);
  const byFilter = state.allRows.filter((r) => matcher(r.kind));
  return searchRows(byFilter, state.search.query);
}

function clampSelect(state: DashState, next: number): DashState {
  const visible = visibleRows(state);
  const max = Math.max(0, visible.length - 1);
  const selected = Math.min(Math.max(0, next), max);
  if (selected === state.selected) return { ...state, selected };
  return { ...state, selected, scroll: { inspector: 0 }, diff: { state: "idle", lines: [] } };
}

export function update(state: DashState, event: DashEvent): DashState {
  if (event.type === "resize") {
    return {
      ...state,
      cols: event.cols,
      rows: event.rows,
      stacked: event.cols < 80 || event.rows < 20,
    };
  }
  if (event.type === "data") {
    return clampSelect(
      {
        ...state,
        allRows: event.rows,
        coverageLine: event.coverageLine,
        reloadRequested: false,
      },
      state.selected,
    );
  }
  if (event.type === "diff-loading") {
    return state.diff.state === "idle"
      ? { ...state, diff: { state: "loading", rowId: event.rowId, lines: [] } }
      : state;
  }
  if (event.type === "diff-ready") {
    const current = visibleRows(state)[state.selected];
    if (current === undefined || current.id !== event.rowId) return state; // stale result discarded
    return { ...state, diff: { state: "ready", rowId: event.rowId, lines: event.lines } };
  }
  return handleKey(state, event.key);
}

function searchType(state: DashState, text: string): DashState {
  const clean = text.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 120);
  return {
    ...state,
    search: { active: true, query: (state.search.query + clean).slice(0, 120) },
  };
}

function handleKey(state: DashState, key: Key): DashState {
  if (key.name === "ctrl-c") return { ...state, quit: true };
  if (state.help) return { ...state, help: false }; // any key closes help, swallowed
  if (state.search.active) {
    if (key.name === "esc") return { ...state, search: { active: false, query: "" } };
    if (key.name === "enter") return { ...state, search: { ...state.search, active: false } };
    if (key.name === "backspace") return { ...state, search: { active: true, query: state.search.query.slice(0, -1) } };
    if (key.name === "paste") return searchType(state, key.text);
    if (key.name === "char") return searchType(state, key.ch);
    return state;
  }
  if (key.name === "paste") return state; // inert outside search
  if (key.name === "char" && key.ch === "?") return { ...state, help: true };
  if (key.name === "char" && key.ch === "/") return { ...state, search: { active: true, query: "" } };
  if (key.name === "char" && key.ch === "q") return { ...state, quit: true };
  if (key.name === "char" && key.ch === "r") return { ...state, reloadRequested: true };
  if (key.name === "tab" || key.name === "shifttab") {
    return { ...state, focus: state.focus === "list" ? "inspector" : "list" };
  }
  if (key.name === "char" && key.ch === "f" && state.focus === "list") {
    const next = FILTER_ORDER[(FILTER_ORDER.indexOf(state.filter) + 1) % FILTER_ORDER.length];
    return clampSelect({ ...state, filter: next }, 0);
  }
  if (key.name === "char" && (key.ch === "[" || key.ch === "]")) {
    const tabs: TabId[] = ["info", "rationale", "diff", "json"];
    const delta = key.ch === "]" ? 1 : tabs.length - 1;
    return { ...state, tab: tabs[(tabs.indexOf(state.tab) + delta) % tabs.length] };
  }
  if (key.name === "char" && key.ch === "d") return { ...state, fullDiff: !state.fullDiff };
  if (key.name === "char" && key.ch === "w" && (state.focus === "inspector" || state.fullDiff)) {
    return { ...state, wrap: !state.wrap };
  }
  if (key.name === "esc") {
    if (state.fullDiff) return { ...state, fullDiff: false };
    if (state.focus === "inspector") return { ...state, focus: "list", inspectorOpen: false };
    return state; // top level: no-op
  }

  const half = Math.max(1, Math.floor((state.rows - 6) / 2));
  if (state.focus === "list") {
    if (key.name === "down" || (key.name === "char" && key.ch === "j")) {
      return clampSelect(state, state.selected + 1);
    }
    if (key.name === "up" || (key.name === "char" && key.ch === "k")) {
      return clampSelect(state, state.selected - 1);
    }
    if (key.name === "ctrl-d") {
      return clampSelect(state, state.selected + half);
    }
    if (key.name === "ctrl-u") {
      return clampSelect(state, state.selected - half);
    }
    if (key.name === "char" && key.ch === "g") {
      return clampSelect(state, 0);
    }
    if (key.name === "char" && key.ch === "G") {
      return clampSelect(state, Number.MAX_SAFE_INTEGER);
    }
    if (key.name === "enter") {
      return { ...state, focus: "inspector", inspectorOpen: true };
    }
  }

  if (state.focus === "inspector") {
    if (key.name === "down" || (key.name === "char" && key.ch === "j")) {
      return { ...state, scroll: { inspector: state.scroll.inspector + 1 } };
    }
    if (key.name === "up" || (key.name === "char" && key.ch === "k")) {
      return { ...state, scroll: { inspector: Math.max(0, state.scroll.inspector - 1) } };
    }
    if (key.name === "ctrl-d") {
      return { ...state, scroll: { inspector: state.scroll.inspector + half } };
    }
    if (key.name === "ctrl-u") {
      return { ...state, scroll: { inspector: Math.max(0, state.scroll.inspector - half) } };
    }
    if (key.name === "char" && key.ch === "g") {
      return { ...state, scroll: { inspector: 0 } };
    }
    if (key.name === "char" && key.ch === "G") {
      return { ...state, scroll: { inspector: Number.MAX_SAFE_INTEGER } };
    }
  }

  return state;
}
