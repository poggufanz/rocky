import { chmodSync, copyFileSync, existsSync, lstatSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Frozen from the harness capture recorded in README.md. The trailing
// double dash keeps the prompt from being read as an allowedTools value.
export const MODEL = "claude-sonnet-5-5";
export const CLAUDE_FLAGS = Object.freeze([
  "-p",
  "--output-format",
  "stream-json",
  "--verbose",
  "--max-turns",
  "30",
  "--model",
  MODEL,
  "--effort",
  "high",
  "--allowedTools",
  "Bash,PowerShell,Edit,Write,Read,Glob,Grep,mcp__rocky__*",
  "--",
]);

/** @type {import("./index.mjs").EvalDriver} */
export const claudeCodeDriver = Object.freeze({
  id: "claude-code",
  instructionFile: "CLAUDE.md",
  configDirName: ".claude",
  configEnvName: "CLAUDE_CONFIG_DIR",
  lanes: Object.freeze(["lane1", "lane2", "mcp"]),
  defaultModel: MODEL,
  defaultFlags: CLAUDE_FLAGS,

  buildCommand(prompt, model = MODEL) {
    const args = [...CLAUDE_FLAGS, prompt];
    args[args.indexOf("--model") + 1] = model;
    return { file: "claude", args };
  },

  setupSandbox({ dir, configDir, env, sandboxEnv, auth, platform, installRocky }) {
    const secrets = [];
    if (auth?.kind === "token") {
      const token = env.ROCKY_EVAL_OAUTH_TOKEN;
      if (typeof token !== "string" || token.length === 0) {
        throw new Error("Missing ROCKY_EVAL_OAUTH_TOKEN in harness environment");
      }
      sandboxEnv.CLAUDE_CODE_OAUTH_TOKEN = token;
      secrets.push(token);
    } else if (auth?.kind === "copy-credentials") {
      if (typeof auth.from !== "string" || auth.from.length === 0) {
        throw new Error("copy-credentials auth requires a 'from' file path");
      }
      if (!existsSync(auth.from) || !lstatSync(auth.from).isFile()) {
        throw new Error(`Credentials file does not exist or is not a file: ${auth.from}`);
      }
      const dest = join(configDir, ".credentials.json");
      copyFileSync(auth.from, dest);
      if (platform !== "win32") chmodSync(dest, 0o600);
    } else if (auth !== undefined) {
      throw new Error(`Unsupported auth kind: ${String(auth.kind)}`);
    }

    const setupRocky = installRocky(secrets);
    if (!setupRocky) return;

    // Agent-hook setup requires a TTY for consent. Apply the preload only to
    // this setup child and pipe its confirmation.
    const ttyPreload = join(dir, ".tty-confirm-preload.cjs");
    writeFileSync(
      ttyPreload,
      'Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });\n',
      "utf8",
    );
    try {
      const preloadPath = platform === "win32" ? ttyPreload.replaceAll("\\", "/") : ttyPreload;
      setupRocky(["setup", "--agent-hooks"], {
        env: { ...sandboxEnv, NODE_OPTIONS: `--require ${JSON.stringify(preloadPath)}` },
        input: "y\n",
      });
    } finally {
      rmSync(ttyPreload, { force: true });
    }
  },

  ownerConfigPaths(home, env) {
    const paths = [join(home, ".claude", "settings.json")];
    const custom = env.CLAUDE_CONFIG_DIR;
    if (typeof custom === "string" && custom.trim().length > 0) {
      paths.push(join(resolve(custom), "settings.json"));
    }
    return paths;
  },

  createReducer() {
    throw new Error("Claude Code eval reducer is not implemented");
  },
});
