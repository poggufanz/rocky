import { StringDecoder } from "node:string_decoder";
import { Key } from "./state.js";

const PASTE_END = "\x1b[201~";

export function createKeyParser(
  emit: (key: Key) => void,
  schedule: (fn: () => void, ms: number) => () => void,
): { feed(chunk: Buffer): void } {
  const decoder = new StringDecoder("utf8");
  let state: "NORMAL" | "ESC" | "CSI" | "SS3" | "PASTE" = "NORMAL";
  let timerCancel: (() => void) | null = null;
  let csiBuffer = "";
  let pasteBuffer = "";
  let matchedEnd = "";

  function cancelEscTimer() {
    if (timerCancel !== null) {
      timerCancel();
      timerCancel = null;
    }
  }

  function processNormalChar(ch: string) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) return;

    if (ch === "\x1b") {
      cancelEscTimer();
      state = "ESC";
      timerCancel = schedule(() => {
        if (state === "ESC") {
          state = "NORMAL";
          timerCancel = null;
          emit({ name: "esc" });
        }
      }, 50);
      return;
    }

    if (ch === "\x03") {
      emit({ name: "ctrl-c" });
      return;
    }
    if (ch === "\x04") {
      emit({ name: "ctrl-d" });
      return;
    }
    if (ch === "\x15") {
      emit({ name: "ctrl-u" });
      return;
    }
    if (ch === "\r" || ch === "\n") {
      emit({ name: "enter" });
      return;
    }
    if (ch === "\t") {
      emit({ name: "tab" });
      return;
    }
    if (ch === "\x7f" || ch === "\x08") {
      emit({ name: "backspace" });
      return;
    }

    if (cp >= 32 && cp !== 127) {
      emit({ name: "char", ch });
    }
  }

  function processChar(ch: string) {
    if (state === "PASTE") {
      if (ch === PASTE_END[matchedEnd.length]) {
        matchedEnd += ch;
        if (matchedEnd === PASTE_END) {
          emit({ name: "paste", text: pasteBuffer });
          pasteBuffer = "";
          matchedEnd = "";
          state = "NORMAL";
        }
      } else {
        pasteBuffer += matchedEnd;
        if (ch === "\x1b") {
          matchedEnd = "\x1b";
        } else {
          pasteBuffer += ch;
          matchedEnd = "";
        }
      }
      return;
    }

    if (state === "ESC") {
      cancelEscTimer();
      if (ch === "[") {
        state = "CSI";
        csiBuffer = "";
        return;
      }
      if (ch === "O") {
        state = "SS3";
        return;
      }
      if (ch === "\x1b") {
        emit({ name: "esc" });
        state = "ESC";
        timerCancel = schedule(() => {
          if (state === "ESC") {
            state = "NORMAL";
            timerCancel = null;
            emit({ name: "esc" });
          }
        }, 50);
        return;
      }
      emit({ name: "esc" });
      state = "NORMAL";
      processNormalChar(ch);
      return;
    }

    if (state === "SS3") {
      state = "NORMAL";
      if (ch === "A") {
        emit({ name: "up" });
      } else if (ch === "B") {
        emit({ name: "down" });
      } else if (ch === "C") {
        emit({ name: "right" });
      } else if (ch === "D") {
        emit({ name: "left" });
      }
      return;
    }

    if (state === "CSI") {
      if (csiBuffer === "") {
        if (ch === "A") {
          emit({ name: "up" });
          state = "NORMAL";
          return;
        }
        if (ch === "B") {
          emit({ name: "down" });
          state = "NORMAL";
          return;
        }
        if (ch === "C") {
          emit({ name: "right" });
          state = "NORMAL";
          return;
        }
        if (ch === "D") {
          emit({ name: "left" });
          state = "NORMAL";
          return;
        }
        if (ch === "Z") {
          emit({ name: "shifttab" });
          state = "NORMAL";
          return;
        }
      }

      if ((ch >= "0" && ch <= "9") || ch === ";" || ch === "?" || ch === "<" || ch === "=" || ch === ">") {
        csiBuffer += ch;
        if (csiBuffer.length > 32) {
          state = "NORMAL";
        }
        return;
      }

      if (ch === "~") {
        if (csiBuffer === "200") {
          state = "PASTE";
          pasteBuffer = "";
          matchedEnd = "";
        } else {
          state = "NORMAL";
        }
        return;
      }

      if (ch === "\x1b") {
        state = "ESC";
        timerCancel = schedule(() => {
          if (state === "ESC") {
            state = "NORMAL";
            timerCancel = null;
            emit({ name: "esc" });
          }
        }, 50);
        return;
      }

      state = "NORMAL";
      return;
    }

    processNormalChar(ch);
  }

  return {
    feed(chunk: Buffer) {
      const text = decoder.write(chunk);
      for (const ch of text) {
        processChar(ch);
      }
    },
  };
}

export function attachRawInput(
  stdin: NodeJS.ReadStream,
  parser: { feed(chunk: Buffer): void },
): () => void {
  if (stdin.isTTY && typeof stdin.setRawMode === "function") {
    try {
      stdin.setRawMode(true);
    } catch {
      // Ignored for non-standard TTY environments that throw on raw mode
    }
  }

  const onData = (chunk: Buffer | string) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    parser.feed(buf);
  };

  stdin.on("data", onData);

  if (typeof stdin.resume === "function") {
    try {
      stdin.resume();
    } catch {
      // Ignored
    }
  }

  return () => {
    stdin.removeListener("data", onData);
    if (typeof stdin.pause === "function") {
      try {
        stdin.pause();
      } catch {
        // Ignored
      }
    }
    if (stdin.isTTY && typeof stdin.setRawMode === "function") {
      try {
        stdin.setRawMode(false);
      } catch {
        // Ignored
      }
    }
  };
}
