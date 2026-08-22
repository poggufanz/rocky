import { MOUSE_ENABLE, MOUSE_DISABLE } from "./core/mouse.js";

export function diffFrames(previous: string[] | undefined, next: string[]): string {
  if (previous === undefined) {
    if (next.length === 0) return "";
    const parts: string[] = ["\x1b[H"];
    for (let i = 0; i < next.length; i++) {
      parts.push(`\x1b[${i + 1};1H${next[i]}\x1b[K`);
    }
    return `\x1b[?2026h${parts.join("")}\x1b[?2026l`;
  }

  const parts: string[] = [];
  const maxLen = Math.max(previous.length, next.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < next.length) {
      if (previous[i] !== next[i]) {
        parts.push(`\x1b[${i + 1};1H${next[i]}\x1b[K`);
      }
    } else {
      parts.push(`\x1b[${i + 1};1H\x1b[K`);
    }
  }

  if (parts.length === 0) return "";
  return `\x1b[?2026h${parts.join("")}\x1b[?2026l`;
}

export interface ScreenOptions {
  mouse?: boolean;
}

export interface Screen {
  enter(): void;
  paint(lines: string[]): void;
  resetDiff(): void;
  leave(): void;
}

export function createScreen(stdout: NodeJS.WriteStream, options?: { mouse?: boolean; pageBg?: string }): Screen {
  let previous: string[] | undefined = undefined;
  let entered = false;

  const cleanup = () => {
    if (!entered) return;
    entered = false;
    detachHandlers();
    try {
      const restore =
        (options?.mouse ? MOUSE_DISABLE : "") +
        (options?.pageBg !== undefined ? "\x1b]111\x1b\\" : "") +
        "\x1b[0m\x1b[?25h\x1b[?2004l\x1b[?1049l";
      stdout.write(restore);
    } catch {
      // Ignored during shutdown
    }
  };

  const onExit = () => {
    cleanup();
  };
  const onSigint = () => {
    cleanup();
    process.exit(130);
  };
  const onSigterm = () => {
    cleanup();
    process.exit(143);
  };
  const onSigtstp = () => {
    cleanup();
  };
  const onUncaughtException = (err: unknown) => {
    cleanup();
    process.removeListener("uncaughtException", onUncaughtException);
    throw err;
  };

  function attachHandlers() {
    try { process.once("exit", onExit); } catch {}
    try { process.once("SIGINT", onSigint); } catch {}
    try { process.once("SIGTERM", onSigterm); } catch {}
    try { process.once("SIGTSTP", onSigtstp); } catch {}
    try { process.once("uncaughtException", onUncaughtException); } catch {}
  }

  function detachHandlers() {
    try { process.removeListener("exit", onExit); } catch {}
    try { process.removeListener("SIGINT", onSigint); } catch {}
    try { process.removeListener("SIGTERM", onSigterm); } catch {}
    try { process.removeListener("SIGTSTP", onSigtstp); } catch {}
    try { process.removeListener("uncaughtException", onUncaughtException); } catch {}
  }

  return {
    enter() {
      if (entered) return;
      entered = true;
      attachHandlers();
      try {
        const enterSeq =
          "\x1b[?1049h\x1b[?25l\x1b[?2004h" +
          (options?.pageBg !== undefined ? `\x1b]11;${options.pageBg}\x1b\\` : "") +
          (options?.mouse ? MOUSE_ENABLE : "");
        stdout.write(enterSeq);
      } catch {
        // Ignored
      }
    },
    paint(lines: string[]) {
      const chunk = diffFrames(previous, lines);
      if (chunk.length > 0) {
        try {
          stdout.write(chunk);
        } catch {
          // Ignored
        }
        previous = lines.slice();
      }
    },
    resetDiff() {
      previous = undefined;
    },
    leave() {
      cleanup();
    },
  };
}
