import { spawn } from "node:child_process";
import { say, heading, detail } from "../ui/rocky.js";
import { phrase } from "../ui/phrases.js";
import { startGui, DEFAULT_GUI_PORT } from "../gui/server.js";

/** The platform's own "open this URL" command. */
export function openerFor(platform: NodeJS.Platform, url: string): { command: string; args: string[] } {
  const command = platform === "win32" ? "cmd" : platform === "darwin" ? "open" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  return { command, args };
}

/** Opening a browser is a convenience, never a requirement: the URL is printed
 *  first, so a failed spawn costs the user nothing. A missing opener is reported
 *  as an async "error" event, not a throw, so it needs a listener or it kills
 *  the foreground GUI. `onFail` hears both ways; the opener's exit code is
 *  never observed. */
export function openBrowser(
  url: string,
  onFail: () => void,
  opener: { command: string; args: string[] } = openerFor(process.platform, url),
): void {
  try {
    const child = spawn(opener.command, opener.args, { stdio: "ignore", detached: true });
    child.on("error", onFail);
    child.unref();
  } catch {
    onFail();
  }
}

/** A browser needs a human at the keyboard, so a pipe gets no GUI. The one
 *  exception is `--no-open`: it launches nothing, so no terminal is needed. */
export function guiWanted(flags: readonly string[], stdoutTty: boolean, stdinTty: boolean): boolean {
  return (stdoutTty && stdinTty) || flags.includes("--no-open");
}

export type GuiSegment = "main" | "dash" | "listening";
export async function guiCommand(rest: string[], segment: GuiSegment): Promise<number> {
  const noOpen = rest.includes("--no-open");
  const portArg = rest.find((arg) => arg.startsWith("--port="));
  const port = portArg ? Number(portArg.slice("--port=".length)) : DEFAULT_GUI_PORT;

  let handle;
  try {
    // the foreground CLI owns the collector for every consented repo (spec §3)
    handle = await startGui({ port: Number.isFinite(port) ? port : DEFAULT_GUI_PORT, collect: true });
  } catch {
    say("rocky cannot open door here. port busy, question");
    return 1;
  }

  const url = segment === "dash"
    ? `http://127.0.0.1:${handle.port}/?v=dash#${handle.token}`
    : segment === "listening"
      ? `http://127.0.0.1:${handle.port}/?v=listening#${handle.token}`
      : handle.url;

  heading("rocky listening");
  detail(`heard at ${url}`);
  detail("ctrl-c stops rocky");
  if (!noOpen) openBrowser(url, () => say(phrase("gui-opener-failed")));

  // foreground until interrupted: no daemon, no port file, nothing left behind
  await new Promise<void>((done) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) process.exit(0);
      stopping = true;
      const timer = setTimeout(() => done(), 500);
      void handle.close().finally(() => {
        clearTimeout(timer);
        done();
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}
