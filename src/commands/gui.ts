import { spawn } from "node:child_process";
import { say, heading, detail } from "../ui/rocky.js";
import { startGui, DEFAULT_GUI_PORT } from "../gui/server.js";

/** Opening a browser is a convenience, never a requirement: the URL is printed
 *  first, so a failed spawn costs the user nothing. */
function openBrowser(url: string): void {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // the printed url is enough
  }
}

export async function guiCommand(rest: string[], segment: "main" | "dash"): Promise<number> {
  const noOpen = rest.includes("--no-open");
  const portArg = rest.find((arg) => arg.startsWith("--port="));
  const port = portArg ? Number(portArg.slice("--port=".length)) : DEFAULT_GUI_PORT;

  let handle;
  try {
    handle = await startGui({ port: Number.isFinite(port) ? port : DEFAULT_GUI_PORT });
  } catch {
    say("rocky cannot open door here. port busy, question");
    return 1;
  }

  const url = segment === "dash"
    ? `http://127.0.0.1:${handle.port}/?v=dash#${handle.token}`
    : handle.url;

  heading("rocky listening");
  detail(`heard at ${url}`);
  detail("ctrl-c stops rocky");
  if (!noOpen) openBrowser(url);

  // foreground until interrupted: no daemon, no port file, nothing left behind
  await new Promise<void>((done) => {
    const stop = (): void => {
      void handle.close().then(done);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}
