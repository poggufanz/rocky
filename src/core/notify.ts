/**
 * Best-effort desktop notification for `rocky watch`. Never a source of
 * truth — if the platform has no known notifier, or the spawn fails or
 * times out, this falls back to a terminal bell and stays silent. It never
 * throws and never changes an exit code.
 */

import { spawn } from "node:child_process";

export interface NotifyInput {
  cmd: string;
  ok: boolean;
  durationMs: number;
}

const NOTIFY_TIMEOUT_MS = 2000;
const CMD_TRUNCATE_LENGTH = 60;

/** "13m32s", "45s", "1h02m03s" — compact, for notifications and --quiet. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h${String(minutes).padStart(2, "0")}m${String(seconds).padStart(2, "0")}s`;
  }
  if (minutes > 0) {
    return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

/** "812 seconds", "1 second" — Rocky counts precisely, in total seconds. */
export function spokenDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  return `${totalSeconds} second${totalSeconds === 1 ? "" : "s"}`;
}

function notificationBody(input: NotifyInput): string {
  const cmd = input.cmd.slice(0, CMD_TRUNCATE_LENGTH);
  return `${cmd} — ${input.ok ? "ok" : "fail"} — ${formatDuration(input.durationMs)}`;
}

function escapeAppleScriptString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/** Pure: the argv a platform would use, or undefined when unsupported. */
export function notifyArgv(
  input: NotifyInput,
  platform: NodeJS.Platform,
): { file: string; args: string[] } | undefined {
  const title = "rocky";
  const body = notificationBody(input);
  if (platform === "linux") {
    return { file: "notify-send", args: [title, body] };
  }
  if (platform === "darwin") {
    const script = `display notification "${escapeAppleScriptString(body)}" with title "${escapeAppleScriptString(title)}"`;
    return { file: "osascript", args: ["-e", script] };
  }
  return undefined;
}

/** Best-effort. Never throws, never returns a failure the caller must handle. */
export function notify(input: NotifyInput): void {
  try {
    const argv = notifyArgv(input, process.platform);
    if (!argv) {
      process.stderr.write("\x07");
      return;
    }
    const child = spawn(argv.file, argv.args, {
      detached: true,
      stdio: "ignore",
      timeout: NOTIFY_TIMEOUT_MS,
    });
    child.on("error", () => {
      try {
        process.stderr.write("\x07");
      } catch {
        // best-effort: nothing more to do
      }
    });
    child.unref();
  } catch {
    try {
      process.stderr.write("\x07");
    } catch {
      // best-effort: nothing more to do
    }
  }
}
