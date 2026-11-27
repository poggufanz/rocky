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

/** @type {import("./index.mjs").EvalDriver} */
export const codexDriver = Object.freeze({
  id: "codex",
  instructionFile: "AGENTS.md",
  configDirName: ".codex",
  configEnvName: "CODEX_HOME",
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
    const key = env.ROCKY_EVAL_CODEX_API_KEY ?? env.ROCKY_EVAL_OPENAI_API_KEY;
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

  createReducer() {
    throw new Error("Codex eval reducer is not implemented");
  },
});
