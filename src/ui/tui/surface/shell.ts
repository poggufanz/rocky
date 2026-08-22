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
import { loadMemoryChecked, type MemoryRecord } from "../../../core/memory-read.js";
import { resolveRockyPaths } from "../../../core/state-paths.js";
import { adaptHit } from "./home-data.js";
import { tokens, similarity } from "../../../core/fingerprint.js";
import { elapsed } from "../../rocky.js";
import type { Key } from "../state.js";

export interface ShellState {
  view: "home" | "stream";
  input: string;
  csel: number;
  scroll: number;
  cwd: string;
  cards: Card[];
  quit: boolean;
  pendingRun?: string;
}

export type ShellEvent =
  | { type: "key"; key: Key }
  | { type: "card"; card: Card }
  | { type: "cd"; next: string };

export function initialShell(cwd: string): ShellState {
  return {
    view: "home",
    input: "",
    csel: 0,
    scroll: 0,
    cwd,
    cards: [],
    quit: false,
    pendingRun: undefined,
  };
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

export function runSurface(opts: {
  stdout: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
  env: NodeJS.ProcessEnv;
  view?: "home" | "stream";
}): Promise<number> {
  let state = initialShell(process.cwd());
  if (opts.view) {
    state = { ...state, view: opts.view };
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

    live.setRoot((sz) => surfaceRoot(state, sz, live.frame, ascii));
    live.onKey((k) => {
      dispatch({ type: "key", key: k });
    });
    live.start();
  });
}
