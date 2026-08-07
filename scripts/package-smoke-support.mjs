import { posix, win32 } from "node:path";

const UNSAFE_WINDOWS_COMMAND_TOKEN = /["\r\n\0%!]/u;
const UNSAFE_NODE_OPTION_PATH = /["\r\n\0]/u;

function quoteWindowsCommandToken(value) {
  if (typeof value !== "string" || UNSAFE_WINDOWS_COMMAND_TOKEN.test(value)) {
    throw new Error("unsafe Windows command token");
  }
  return `"${value}"`;
}

export function commandInvocation(file, args, platform, comSpec) {
  const copiedArgs = [...args];
  const extension = win32.extname(file).toLowerCase();
  if (platform !== "win32" || (extension !== ".cmd" && extension !== ".bat")) {
    return { file, args: copiedArgs };
  }
  if (!win32.isAbsolute(file)) throw new Error("unsafe relative Windows command script");
  if (typeof comSpec !== "string" || !win32.isAbsolute(comSpec)) {
    throw new Error("safe absolute Windows command processor is unavailable");
  }
  const command = [file, ...copiedArgs].map(quoteWindowsCommandToken).join(" ");
  return {
    file: comSpec,
    args: ["/d", "/s", "/c", `"${command}"`],
  };
}

export function fakeClientLaunchers(platform, directory) {
  const pathApi = platform === "win32" ? win32 : posix;
  const type = platform === "win32" ? "copy-node" : "posix-wrapper";
  const extension = platform === "win32" ? ".exe" : "";
  return ["codex", "claude"].map((kind) => ({
    kind,
    path: pathApi.join(directory, `${kind}${extension}`),
    type,
  }));
}

export function nodeOptionsRequire(path, platform) {
  if (typeof path !== "string" || path.length === 0 || UNSAFE_NODE_OPTION_PATH.test(path)) {
    throw new Error("unsafe Node preload path");
  }
  const normalized = platform === "win32" ? path.replaceAll("\\", "/") : path;
  return `--require ${JSON.stringify(normalized)}`;
}

export function shouldRunInstalledSetup(platform) {
  void platform;
  return true;
}
