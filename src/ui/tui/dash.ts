import { detectColorDepth } from "./theme.js";
import { initialState, update, visibleRows, type DashEvent } from "./state.js";
import { loadDashRows } from "./data.js";
import { createDiffLoader } from "./diff.js";
import { createKeyParser, attachRawInput } from "./input.js";
import { createScreen } from "./screen.js";
import { render } from "./view.js";
import { resolveRockyPaths } from "../../core/state-paths.js";
import { resolveGitDiff, formatGitDiffLines } from "../../core/git-diff.js";
import { redactSecretsAtBoundary } from "../../core/redact.js";

export interface RunDashboardOptions {
  initialQuery?: string;
  stdout: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
  env?: NodeJS.ProcessEnv;
}

export function runDashboard(options: RunDashboardOptions): Promise<number> {
  return new Promise((resolve) => {
    const env = options.env ?? process.env;
    const stdout = options.stdout;
    const stdin = options.stdin;
    const initialQuery = options.initialQuery ?? "";

    const depth = detectColorDepth(env, () =>
      typeof stdout.getColorDepth === "function" ? stdout.getColorDepth() : 4,
    );
    const ascii = process.platform === "win32" && !env.WT_SESSION;

    const cols = stdout.columns ?? 80;
    const rows = stdout.rows ?? 24;
    let state = initialState(cols, rows);
    if (initialQuery !== "") {
      state = { ...state, search: { active: false, query: initialQuery } };
    }

    const rockyPaths = resolveRockyPaths(env);
    const initialData = loadDashRows(rockyPaths.memory, Date.now());
    state = update(state, {
      type: "data",
      rows: initialData.rows,
      coverageLine: initialData.coverageLine,
    });

    const diffLoader = createDiffLoader({
      resolve: (query) => {
        const result = resolveGitDiff({ ts: query.ts });
        return formatGitDiffLines(result).map((l) => redactSecretsAtBoundary(l));
      },
      debounceMs: 150,
    });

    let lastSelectedRowId: string | undefined = visibleRows(state)[state.selected]?.id;
    diffLoader.select(visibleRows(state)[state.selected], Date.now());

    const screen = createScreen(stdout);
    screen.enter();

    function renderScreen() {
      const lines = render(state, { cols: state.cols, rows: state.rows }, depth, ascii);
      screen.paint(lines);
    }

    function dispatch(event: DashEvent) {
      if (state.quit) return;
      state = update(state, event);

      if (state.reloadRequested) {
        const reloaded = loadDashRows(rockyPaths.memory, Date.now());
        state = update(state, {
          type: "data",
          rows: reloaded.rows,
          coverageLine: reloaded.coverageLine,
        });
      }

      const currentSelected = visibleRows(state)[state.selected];
      if (currentSelected?.id !== lastSelectedRowId) {
        lastSelectedRowId = currentSelected?.id;
        diffLoader.select(currentSelected, Date.now());
        const immediate = diffLoader.due(Date.now());
        if (immediate !== undefined) {
          state = update(state, immediate);
        }
      }

      if (state.quit) {
        cleanupAndExit(0);
        return;
      }

      renderScreen();
    }

    const activeTimers = new Set<NodeJS.Timeout>();
    function scheduleTimer(fn: () => void, ms: number): () => void {
      const timer = setTimeout(() => {
        activeTimers.delete(timer);
        fn();
      }, ms);
      activeTimers.add(timer);
      return () => {
        clearTimeout(timer);
        activeTimers.delete(timer);
      };
    }

    const keyParser = createKeyParser((key) => {
      dispatch({ type: "key", key });
    }, scheduleTimer);

    const detachInput = attachRawInput(stdin, keyParser);

    let resizeTimer: NodeJS.Timeout | undefined;
    const onResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        screen.resetDiff();
        dispatch({
          type: "resize",
          cols: stdout.columns ?? 80,
          rows: stdout.rows ?? 24,
        });
      }, 50);
    };

    try {
      stdout.on("resize", onResize);
    } catch {
      // Ignored if resize not supported
    }

    const tickInterval = setInterval(() => {
      const now = Date.now();
      const dueEvent = diffLoader.due(now);
      if (dueEvent !== undefined) {
        dispatch(dueEvent);
      }
    }, 50);

    let cleanedUp = false;
    function cleanupAndExit(code: number) {
      if (cleanedUp) return;
      cleanedUp = true;

      clearInterval(tickInterval);
      if (resizeTimer) clearTimeout(resizeTimer);
      for (const t of activeTimers) {
        clearTimeout(t);
      }
      activeTimers.clear();

      try {
        stdout.removeListener("resize", onResize);
      } catch {
        // Ignored
      }

      detachInput();
      screen.leave();
      resolve(code);
    }

    // Initial render
    renderScreen();
  });
}
