import { claudeCodeDriver } from "./claude-code.mjs";
import { codexDriver } from "./codex.mjs";

/** @typedef {"claude-code" | "codex"} EvalProvider */
/** @typedef {Record<string, string | undefined>} Env */
/** @typedef {{ name: string, command: string }} ShellUse */
/** @typedef {ShellUse & { turn: number, output: string, isError: boolean | null, exitCode?: number | null }} ShellCall */
/**
 * @typedef {{
 *   consume: (event: any) => void,
 *   finish: () => {
 *     toolCalls: ShellCall[],
 *     fileEdits: string[],
 *     mcpCalls: Array<{ name?: string, server?: string, tool?: string }>,
 *     numTurns: number,
 *     wallMs: number | null,
 *     resultEvent: any,
 *     shellUses: ShellUse[],
 *     toolOutputs: string[],
 *   },
 * }} EvalReducer
 */
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
 *   tokenEnvNames: readonly string[],
 *   lanes: readonly string[],
 *   defaultModel: string,
 *   defaultFlags: readonly string[],
 *   buildCommand: (prompt: string, model?: string, options?: { taskDir?: string, platform?: NodeJS.Platform }) => { file: string, args: string[] },
 *   setupSandbox: (ctx: SandboxContext) => void,
 *   ownerConfigPaths: (home: string, env: Env) => string[],
 *   summarizeResult: (event: any) => { subtype: unknown, is_error: unknown } | null,
 *   createReducer: () => EvalReducer,
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

export function getEvalToken(driver, env = process.env) {
  return driver.tokenEnvNames.map((name) => env[name]).find((value) => Boolean(value));
}

export function savedEvalProvider(record) {
  // Only Claude Code produced records before the provider field existed.
  return record?.provider === undefined ? "claude-code" : record.provider;
}
