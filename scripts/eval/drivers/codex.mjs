import { join, resolve } from "node:path";

export const CODEX_MODEL = "gpt-6.2-sol";

// Keep in sync with the frozen Codex harness capture in README.md.
function codexFlags(taskDir, model, platform) {
  const flags = ["--json", "-C", taskDir, "-s", "workspace-write", "--ephemeral"];
  if (platform === "win32") flags.push("-c", "windows.sandbox=unelevated");
  flags.push("-m", model);
  return flags;
}

export const CODEX_FLAGS = Object.freeze(codexFlags("<taskDir>", CODEX_MODEL, process.platform));
const OWNER_FILES = ["config.toml", "hooks.json", "auth.json"];
const TOKEN_ENV_NAMES = Object.freeze(["ROCKY_EVAL_CODEX_API_KEY", "ROCKY_EVAL_OPENAI_API_KEY"]);

function decodeCommand(command) {
  const match = /^(?:"([^"]+)"|'([^']+)'|(\S+))\s+([\s\S]+)$/.exec(command);
  if (!match) return { name: "Bash", command };
  const executable = (match[1] ?? match[2] ?? match[3]).split(/[\\/]/).at(-1).toLowerCase();
  const args = match[4];
  const isPowerShell = /^(?:pwsh|powershell)(?:\.exe)?$/.test(executable);
  let inner;
  if (isPowerShell) {
    inner = /^(?:(?:-NoLogo|-NoProfile|-NonInteractive|-Login)\s+)*-(?:Command|c)\s+([\s\S]+)$/i.exec(args)?.[1];
  } else if (/^cmd(?:\.exe)?$/.test(executable)) {
    inner = /^(?:(?:\/d|\/s)\s+)*\/[ck]\s+([\s\S]+)$/i.exec(args)?.[1];
  } else if (/^(?:bash|sh|zsh)(?:\.exe)?$/.test(executable)) {
    inner = /^-(?:l?c|cl)\s+([\s\S]+)$/.exec(args)?.[1];
    // The shell's display form escapes literal single quotes between quoted spans.
    if (inner?.startsWith("'") && inner.endsWith("'")) {
      return { name: "Bash", command: inner.slice(1, -1).replaceAll("'\\''", "'") };
    }
  }
  if (inner && ((inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith("'") && inner.endsWith("'")))) {
    inner = inner.slice(1, -1);
  }
  return { name: isPowerShell ? "PowerShell" : "Bash", command: inner ?? command };
}

/** @type {import("./index.mjs").EvalDriver} */
export const codexDriver = Object.freeze({
  id: "codex",
  instructionFile: "AGENTS.md",
  configDirName: ".codex",
  configEnvName: "CODEX_HOME",
  tokenEnvNames: TOKEN_ENV_NAMES,
  lanes: Object.freeze(["lane1", "mcp"]),
  defaultModel: CODEX_MODEL,
  defaultFlags: CODEX_FLAGS,

  buildCommand(prompt, model = CODEX_MODEL, { taskDir = ".", platform = process.platform } = {}) {
    return { file: "codex", args: ["exec", ...codexFlags(taskDir, model, platform), "--", prompt] };
  },

  setupSandbox({ env, sandboxEnv, auth, installRocky }) {
    if (auth !== undefined && auth.kind !== "token") {
      throw new Error(`Unsupported Codex auth kind: ${String(auth.kind)}`);
    }
    const key = TOKEN_ENV_NAMES.map((name) => env[name]).find((value) => Boolean(value));
    if (auth?.kind === "token" && !key) {
      throw new Error("Missing ROCKY_EVAL_CODEX_API_KEY or ROCKY_EVAL_OPENAI_API_KEY in harness environment");
    }

    // Keep the key out of the package install and MCP registration children.
    installRocky();
    if (key) sandboxEnv.CODEX_API_KEY = key;
  },

  ownerConfigPaths(home, env) {
    const dirs = [join(home, ".codex")];
    const custom = env.CODEX_HOME;
    if (typeof custom === "string" && custom.trim().length > 0) dirs.push(resolve(custom));
    return dirs.flatMap((dir) => OWNER_FILES.map((file) => join(dir, file)));
  },

  summarizeResult(event) {
    if (event?.type === "turn.completed") return { subtype: "success", is_error: false };
    if (event?.type === "turn.failed") return { subtype: "turn_failed", is_error: true };
    return null;
  },

  createReducer() {
    const commands = new Map();
    const fileEdits = [];
    const mcpCalls = new Map();
    const toolOutputs = [];
    let numTurns = 0;
    let resultEvent = null;

    return {
      consume(event) {
        if (event?.type === "turn.started") numTurns += 1;
        if (event?.type === "turn.completed" || event?.type === "turn.failed") {
          resultEvent = event;
        }
        const started = event?.type === "item.started";
        const completed = event?.type === "item.completed";
        const item = event?.item;
        if ((!started && !completed) || typeof item?.id !== "string" || !item.id) return;

        if (item.type === "command_execution") {
          const previous = commands.get(item.id);
          if (previous?.completed) return;
          const shell = typeof item.command === "string"
            ? decodeCommand(item.command)
            : previous?.shell;
          if (!shell) return;
          const output = typeof item.aggregated_output === "string" ? item.aggregated_output : "";
          const exitCode = typeof item.exit_code === "number" ? item.exit_code : null;
          commands.set(item.id, { turn: previous?.turn ?? numTurns, shell, completed, output, exitCode });
          if (completed) toolOutputs.push(output);
        } else if (item.type === "file_change" && completed && item.status === "completed") {
          if (!Array.isArray(item.changes)) return;
          for (const change of item.changes) {
            if (typeof change?.path === "string") fileEdits.push(change.path);
          }
        } else if (item.type === "mcp_tool_call" && typeof item.server === "string") {
          mcpCalls.set(item.id, { server: item.server, tool: item.tool });
        }
      },

      finish() {
        const shellUses = [];
        const toolCalls = [];
        for (const { turn, shell, completed, output, exitCode } of commands.values()) {
          shellUses.push(shell);
          if (completed) {
            toolCalls.push({ turn, ...shell, output, exitCode, isError: exitCode === null ? null : exitCode !== 0 });
          }
        }
        return { toolCalls, fileEdits, mcpCalls: [...mcpCalls.values()], numTurns, wallMs: null, resultEvent, shellUses, toolOutputs };
      },
    };
  },
});
