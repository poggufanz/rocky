import { createScreen, type Screen } from "../screen.js";
import { createKeyParser, attachRawInput } from "../input.js";
import { renderToLines } from "./renderer.js";
import type { Node } from "./node.js";
import type { Key } from "../state.js";
import { motionEnabled } from "./motion.js";
import { detectColorDepth, type ColorDepth } from "../theme.js";

export interface LiveOptions {
  stdout: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
  env: NodeJS.ProcessEnv;
  tickMs?: number; // default 50
}

export function mouseAllowed(env: NodeJS.ProcessEnv, platform: string): boolean {
  if (env.ROCKY_TUI_MOUSE === "off") return false;
  if (platform === "win32") return env.WT_SESSION !== undefined;
  return true;
}

export class Live {
  frame = 0;
  private buildRoot?: (size: { cols: number; rows: number; frame: number }) => Node;
  private keyHandler?: (key: Key) => void;
  private screen: Screen;
  private depth: ColorDepth;
  private running = false;
  private tickInterval?: NodeJS.Timeout;
  private resizeTimer?: NodeJS.Timeout;
  private activeTimers = new Set<NodeJS.Timeout>();
  private detachInput?: () => void;
  private onResize?: () => void;

  constructor(private readonly opts: LiveOptions) {
    this.depth = detectColorDepth(opts.env, () =>
      typeof opts.stdout.getColorDepth === "function" ? opts.stdout.getColorDepth() : 4,
    );
    this.screen = createScreen(opts.stdout, {
      mouse: mouseAllowed(opts.env, process.platform),
      // Sync the terminal's default background to the page at truecolor so
      // the window's pixel remainder blends instead of reading as a stripe.
      pageBg: this.depth === 24 ? "#08080a" : undefined,
    });
  }

  setRoot(build: (size: { cols: number; rows: number; frame: number }) => Node): void {
    this.buildRoot = build;
  }

  onKey(handler: (key: Key) => void): void {
    this.keyHandler = handler;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    this.screen.enter();

    const scheduleTimer = (fn: () => void, ms: number): () => void => {
      const timer = setTimeout(() => {
        this.activeTimers.delete(timer);
        fn();
      }, ms);
      this.activeTimers.add(timer);
      return () => {
        clearTimeout(timer);
        this.activeTimers.delete(timer);
      };
    };

    const keyParser = createKeyParser((key) => {
      if (this.keyHandler) {
        this.keyHandler(key);
      }
    }, scheduleTimer);

    this.detachInput = attachRawInput(this.opts.stdin, keyParser);

    this.onResize = () => {
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        this.screen.resetDiff();
        this.requestFrame();
      }, 50);
    };

    try {
      this.opts.stdout.on("resize", this.onResize);
    } catch {
      // Ignored
    }

    const motionOn = motionEnabled(this.opts.env);
    this.tickInterval = setInterval(() => {
      if (motionOn) {
        this.frame++;
      }
      this.requestFrame();
    }, this.opts.tickMs ?? 50);

    this.requestFrame();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = undefined;
    }

    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = undefined;
    }

    for (const t of this.activeTimers) {
      clearTimeout(t);
    }
    this.activeTimers.clear();

    if (this.onResize) {
      try {
        this.opts.stdout.removeListener("resize", this.onResize);
      } catch {
        // Ignored
      }
      this.onResize = undefined;
    }

    if (this.detachInput) {
      try {
        this.detachInput();
      } catch {
        // Ignored
      }
      this.detachInput = undefined;
    }

    this.screen.leave();
  }

  requestFrame(): void {
    if (!this.running || !this.buildRoot) return;
    const cols = this.opts.stdout.columns ?? 80;
    const rows = this.opts.stdout.rows ?? 24;
    const root = this.buildRoot({ cols, rows, frame: this.frame });
    const lines = renderToLines(root, cols, rows, this.depth);
    this.screen.paint(lines);
  }
}
