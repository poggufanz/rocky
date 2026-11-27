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

const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

function extractToolResultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
    } else if (item?.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    }
  }
  return parts.join("\n");
}

function extractEditFilePaths(toolUseBlock) {
  const paths = [];
  const input = toolUseBlock?.input;
  if (!input || typeof input !== "object") return paths;
  if (typeof input.file_path === "string") paths.push(input.file_path);
  if (Array.isArray(input.edits)) {
    for (const edit of input.edits) {
      if (edit && typeof edit === "object" && typeof edit.file_path === "string") {
        paths.push(edit.file_path);
      }
    }
  }
  return paths;
}

/** @type {import("./index.mjs").EvalDriver} */
export const claudeCodeDriver = Object.freeze({
  id: "claude-code",
  instructionFile: "CLAUDE.md",
  configDirName: ".claude",
  configEnvName: "CLAUDE_CONFIG_DIR",
  tokenEnvNames: Object.freeze(["ROCKY_EVAL_OAUTH_TOKEN"]),
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

  summarizeResult(event) {
    return event?.type === "result" ? { subtype: event.subtype, is_error: event.is_error } : null;
  },

  createReducer() {
    const uses = [];
    const resultsById = new Map();
    const seenMessageIds = new Set();
    const shellUses = [];
    const fileEdits = [];
    const mcpCalls = [];
    const toolOutputs = [];
    let assistantTurn = 0;
    let resultEvent = null;

    return {
      consume(event) {
        if (!event || typeof event !== "object") return;
        if (event.type === "result") resultEvent = event;
        if (event.type === "assistant") {
          const msgId = typeof event.message?.id === "string" && event.message.id.length > 0
            ? event.message.id
            : null;
          if (msgId === null) {
            assistantTurn += 1;
          } else if (!seenMessageIds.has(msgId)) {
            seenMessageIds.add(msgId);
            assistantTurn += 1;
          }
          const content = event.message?.content;
          if (!Array.isArray(content)) return;
          for (const block of content) {
            if (!block || typeof block !== "object" || block.type !== "tool_use") continue;
            if (SHELL_TOOLS.has(block.name)) {
              const command = typeof block.input?.command === "string" ? block.input.command : "";
              const shell = { name: block.name, command };
              shellUses.push(shell);
              if (typeof block.id === "string" && block.id.length > 0) {
                uses.push({ id: block.id, turn: assistantTurn, ...shell });
              }
            } else if (EDIT_TOOLS.has(block.name)) {
              for (const path of extractEditFilePaths(block)) fileEdits.push(path);
            } else if (typeof block.name === "string" && block.name.startsWith("mcp__")) {
              mcpCalls.push({ name: block.name });
            }
          }
        } else if (event.type === "user") {
          const content = event.message?.content;
          if (!Array.isArray(content)) return;
          for (const block of content) {
            if (!block || typeof block !== "object" || block.type !== "tool_result") continue;
            const output = extractToolResultText(block.content);
            toolOutputs.push(output);
            if (typeof block.tool_use_id !== "string" || block.tool_use_id.length === 0) continue;
            if (!resultsById.has(block.tool_use_id)) {
              resultsById.set(block.tool_use_id, { output, isError: Boolean(block.is_error) });
            }
          }
        }
      },

      finish() {
        const toolCalls = [];
        for (const { id, ...use } of uses) {
          const result = resultsById.get(id);
          if (result) toolCalls.push({ ...use, ...result });
        }
        const numTurns = typeof resultEvent?.num_turns === "number" ? resultEvent.num_turns : 0;
        const wallMs = typeof resultEvent?.duration_ms === "number" ? resultEvent.duration_ms : 0;
        return { toolCalls, fileEdits, mcpCalls, numTurns, wallMs, resultEvent, shellUses, toolOutputs };
      },
    };
  },
});
