import { claudeCodeDriver } from "./claude-code.mjs";
import { codexDriver } from "./codex.mjs";

/** @typedef {"claude-code" | "codex"} EvalProvider */
/** @typedef {Record<string, string | undefined>} Env */
/**
 * @typedef {(args: string[], options?: { env?: Env, input?: string }) => void} SetupRocky
 */
/**
 * @typedef {{
 *   dir: string,
 *   configDir: string,
 *   env: Env,
 *   sandboxEnv: Record<string, string>,
 *   platform: NodeJS.Platform,
 *   auth?: { kind: "token" } | { kind: "copy-credentials", from: string },
 *   installRocky: (secrets?: string[]) => SetupRocky | undefined,
 * }} SandboxContext
 */
/**
 * @typedef {{
 *   id: EvalProvider,
 *   instructionFile: string,
 *   configDirName: string,
 *   configEnvName: string,
 *   lanes: readonly string[],
 *   defaultModel: string,
 *   defaultFlags: readonly string[],
 *   buildCommand: (prompt: string, model?: string, options?: { taskDir?: string, platform?: NodeJS.Platform }) => { file: string, args: string[] },
 *   setupSandbox: (ctx: SandboxContext) => void,
 *   ownerConfigPaths: (home: string, env: Env) => string[],
 *   createReducer: () => unknown,
 * }} EvalDriver
 */

/**
 * @param {EvalProvider} [provider]
 * @returns {EvalDriver}
 */
export function getEvalDriver(provider = "claude-code") {
  switch (provider) {
    case "claude-code": return claudeCodeDriver;
    case "codex": return codexDriver;
    default: throw new Error(`Unknown eval provider: ${String(provider)}`);
  }
}
