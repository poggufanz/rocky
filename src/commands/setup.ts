import { createInterface } from "node:readline/promises";
import { basename, join, posix } from "node:path";
import type {
  InspectionResult,
  McpRegistration,
  SetupClientAdapter,
  SetupClientId,
  SetupMode,
  SetupResult,
} from "../setup/clients.js";
import { createClaudeCodeAdapter } from "../setup/claude-code.js";
import {
  WslManualConfigurationError,
  buildWslDesktopRegistration,
  convertMountedWindowsPath,
  createClaudeDesktopAdapter,
  createNativeDesktopConfig,
} from "../setup/claude-desktop.js";
import { createCodexAdapter } from "../setup/codex.js";
import { checkMcpRegistration } from "../setup/health.js";
import { SetupUsageError, parseSetupArgs } from "../setup/parser.js";
import { createPlatformServices, type PlatformServices } from "../setup/platform.js";
import { processRunner, type ProcessRunner } from "../setup/process.js";
import {
  isEphemeralInstall,
  isIdenticalMcpRegistration,
  resolveMcpRegistration,
} from "../setup/registration.js";
import {
  checkVoiceSkill,
  installVoiceSkill,
  removeVoiceSkill,
  resolveVoiceSkillTargets,
  type VoiceSkillOperationResult,
  type VoiceSkillTarget,
} from "../setup/voice-skill.js";
import { detail, say } from "../ui/rocky.js";

export interface ConfirmationPort {
  confirm(message: string): Promise<boolean>;
}

export interface SetupDependencies {
  runner: ProcessRunner;
  platform: PlatformServices;
  adapters: readonly SetupClientAdapter[];
  confirmation: ConfirmationPort;
  nodePath?: string;
  entryPath?: string;
  rockyHome?: string;
  env?: NodeJS.ProcessEnv;
  voiceSkills?: VoiceSkillServices;
}

export interface VoiceSkillServices {
  resolveTargets(env: NodeJS.ProcessEnv, home: string): readonly VoiceSkillTarget[];
  install(target: VoiceSkillTarget, replace: boolean): Promise<VoiceSkillOperationResult>;
  check(target: VoiceSkillTarget): Promise<VoiceSkillOperationResult>;
  remove(target: VoiceSkillTarget): Promise<VoiceSkillOperationResult>;
}

interface ConfirmationInput {
  isTTY?: boolean;
  read?: (size?: number) => unknown;
}

export function createConfirmationPort(
  input: ConfirmationInput = process.stdin,
): ConfirmationPort {
  return {
    async confirm(message) {
      if (input.isTTY !== true) return false;
      const terminal = createInterface({
        input: input as NodeJS.ReadStream,
        output: process.stderr,
        terminal: true,
      });
      try {
        const answer = await terminal.question(`[Rocky] ${message} [y/N] `);
        return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
      } finally {
        terminal.close();
      }
    },
  };
}

function unavailableAdapter(id: SetupClientId, unavailableDetail: string): SetupClientAdapter {
  const skipped = (): SetupResult => ({ client: id, status: "skipped", detail: unavailableDetail });
  return {
    id,
    async inspect() { return { state: "blocked", detail: unavailableDetail }; },
    async configure() { return skipped(); },
    async check() { return skipped(); },
    async remove() { return skipped(); },
  };
}

export async function createProductionAdapters(
  platform: PlatformServices,
  runner: ProcessRunner,
  registration: McpRegistration,
): Promise<readonly SetupClientAdapter[]> {
  const common: SetupClientAdapter[] = [
    createCodexAdapter({
      runner,
      executable: platform.resolveExecutable("codex"),
      recoveryBaseDirectory: platform.home,
    }),
    createClaudeCodeAdapter({
      runner,
      executable: platform.resolveExecutable("claude"),
      userConfigPath: join(platform.home, ".claude.json"),
    }),
  ];
  if (!platform.isWsl) {
    const desktop = createNativeDesktopConfig(platform);
    common.push(desktop === undefined
      ? unavailableAdapter("claude-desktop", "Claude Desktop config is not available on this host")
      : !platform.hasClaudeDesktop()
        ? unavailableAdapter("claude-desktop", "Claude Desktop is not installed on this host")
        : createClaudeDesktopAdapter(desktop));
    return common;
  }

  const configPaths = platform.wslDesktopConfigPaths ?? [];
  const wslPaths = platform.wslExecutablePaths ?? [];
  const wslpathPaths = platform.wslpathExecutablePaths ?? [];
  const configPath = configPaths.length === 1 ? configPaths[0] : undefined;
  const mountedWsl = wslPaths.length === 1 ? wslPaths[0] : undefined;
  const wslpath = wslpathPaths.length === 1 ? wslpathPaths[0] : undefined;
  const entryPath = registration.args.length === 2 && registration.args[1] === "mcp"
    ? registration.args[0]
    : undefined;
  const exposure = registration.env.ROCKY_MCP_EXPOSURE;
  const rockyHome = registration.env.ROCKY_HOME;
  const distro = platform.wslDistro?.trim();
  const complete = configPath !== undefined
    && posix.isAbsolute(configPath)
    && platform.fileExists(configPath)
    && mountedWsl !== undefined
    && posix.isAbsolute(mountedWsl)
    && platform.fileExists(mountedWsl)
    && wslpath !== undefined
    && posix.isAbsolute(wslpath)
    && platform.fileExists(wslpath)
    && platform.fileExists("/usr/bin/env")
    && posix.isAbsolute(registration.command)
    && platform.fileExists(registration.command)
    && entryPath !== undefined
    && posix.isAbsolute(entryPath)
    && platform.fileExists(entryPath)
    && distro !== undefined
    && distro.length > 0
    && typeof rockyHome === "string"
    && posix.isAbsolute(rockyHome)
    && (exposure === "sanitized" || exposure === "raw");
  if (!complete) {
    common.push(unavailableAdapter(
      "claude-desktop",
      "WSL Desktop discovery is incomplete or ambiguous; use manual configuration",
    ));
    return common;
  }

  let bridge: McpRegistration;
  try {
    const windowsWsl = await convertMountedWindowsPath({
      mountedPath: mountedWsl,
      wslpathExecutable: wslpath,
      runner,
    });
    bridge = buildWslDesktopRegistration({
      exposure,
      windowsConfigPath: configPath,
      wslExecutable: windowsWsl,
      distro,
      envExecutable: "/usr/bin/env",
      nodePath: registration.command,
      entryPath,
      rockyHome,
    });
  } catch (error) {
    if (!(error instanceof WslManualConfigurationError)) throw error;
    common.push(unavailableAdapter(
      "claude-desktop",
      "WSL Desktop discovery is incomplete or ambiguous; use manual configuration",
    ));
    return common;
  }
  common.push(createClaudeDesktopAdapter({
    configPath,
    transformRegistration: () => bridge,
    mapHealthRegistration: (stored) => ({ ...stored, command: mountedWsl }),
  }));
  return common;
}

function manualAddArguments(client: "codex" | "claude-code", registration: McpRegistration): string[] {
  const args = client === "codex"
    ? ["mcp", "add"]
    : ["mcp", "add", "--scope", "user", "--transport", "stdio"];
  for (const [name, value] of Object.entries(registration.env)) {
    args.push("--env", `${name}=${value}`);
  }
  args.push(registration.name, "--", registration.command, ...registration.args);
  return args;
}

function printResult(mode: SetupMode, result: SetupResult, desired: McpRegistration): void {
  detail(`${result.client}: ${result.status}`);
  if (result.detail !== undefined) detail(result.detail);
  if (mode !== "configure") return;
  if (result.manualRegistration === undefined) return;
  if (!isIdenticalMcpRegistration(result.manualRegistration, desired)) {
    detail(`${result.client} manual registration unavailable; rerun setup for safe guidance`);
    return;
  }
  if (result.client === "codex" || result.client === "claude-code") {
    detail(`${result.client} manual argv: ${JSON.stringify(manualAddArguments(
      result.client,
      result.manualRegistration,
    ))}`);
    return;
  }
  detail(`${result.client} manual config: ${JSON.stringify({
    mcpServers: {
      rocky: {
        type: "stdio",
        command: result.manualRegistration.command,
        args: [...result.manualRegistration.args],
        env: { ...result.manualRegistration.env },
      },
    },
  })}`);
}

function skippedFromInspection(client: SetupClientId, inspection: InspectionResult): SetupResult {
  if (inspection.state === "blocked") {
    return { client, status: "skipped", detail: inspection.detail };
  }
  if (inspection.state === "unreadable") {
    return { client, status: "failed", detail: inspection.detail ?? "Host registration cannot be read" };
  }
  return { client, status: "requires-confirmation" };
}

function failedHostOperation(client: SetupClientId, detailMessage = "Host operation failed"): SetupResult {
  return { client, status: "failed", detail: detailMessage };
}

interface ConsentOutcome {
  results?: SetupResult[];
  inspectionFailures: ReadonlyMap<SetupClientAdapter, SetupResult>;
}

function exitCode(mode: SetupMode, results: readonly SetupResult[]): number {
  if (mode === "configure") {
    const successful = results.some(({ status }) => status === "configured" || status === "already-configured");
    const allowed = results.every(({ status }) => status === "configured"
      || status === "already-configured"
      || status === "skipped");
    return successful && allowed ? 0 : 1;
  }
  if (mode === "check") {
    const testable = results.some(({ status }) => status === "healthy");
    const allowed = results.every(({ status }) => status === "healthy" || status === "skipped");
    return testable && allowed ? 0 : 1;
  }
  return results.every(({ status }) => status === "removed"
    || status === "not-configured"
    || status === "skipped") ? 0 : 1;
}

async function consentResults(
  mode: Exclude<SetupMode, "check">,
  adapters: readonly SetupClientAdapter[],
  registration: McpRegistration,
  confirmation: ConfirmationPort,
  includeVoiceSkill: boolean,
): Promise<ConsentOutcome> {
  const inspections = new Map<SetupClientAdapter, InspectionResult>();
  const inspectionFailures = new Map<SetupClientAdapter, SetupResult>();
  for (const adapter of adapters) {
    try {
      inspections.set(adapter, await adapter.inspect(registration));
    } catch {
      inspectionFailures.set(adapter, failedHostOperation(adapter.id, "Host inspection failed"));
    }
  }
  const orderedResults = (): SetupResult[] => adapters.map((adapter) => {
    const failure = inspectionFailures.get(adapter);
    if (failure !== undefined) return failure;
    const inspection = inspections.get(adapter);
    return inspection === undefined
      ? failedHostOperation(adapter.id, "Host inspection failed")
      : skippedFromInspection(adapter.id, inspection);
  });
  const requiresConsent = [...inspections.values()].some((inspection) => inspection.state !== "blocked"
    && inspection.state !== "unreadable");
  if (!requiresConsent) return { results: orderedResults(), inspectionFailures };
  const prompt = mode === "configure"
    ? includeVoiceSkill
      ? "configure MCP hosts and managed voice skill now, question"
      : "configure MCP hosts now, question"
    : includeVoiceSkill
      ? "remove Rocky from MCP hosts and remove managed voice skill now, question"
      : "remove Rocky from MCP hosts now, question";
  const allowed = await confirmation.confirm(prompt);
  if (allowed) return { inspectionFailures };
  const instruction = mode === "configure" ? "rocky setup --yes" : "rocky setup --remove --yes";
  const results = orderedResults();
  for (const result of results) {
    if (result.status === "requires-confirmation") {
      result.detail = `Confirmation required; rerun with ${instruction}`;
    }
  }
  return { results, inspectionFailures };
}

async function invokeAdapters(
  mode: SetupMode,
  adapters: readonly SetupClientAdapter[],
  registration: McpRegistration,
  replace: boolean,
  runner: ProcessRunner,
  priorFailures: ReadonlyMap<SetupClientAdapter, SetupResult>,
): Promise<SetupResult[]> {
  const results: SetupResult[] = [];
  for (const adapter of adapters) {
    const priorFailure = priorFailures.get(adapter);
    if (priorFailure !== undefined) {
      results.push(priorFailure);
      continue;
    }
    try {
      if (mode === "configure") {
        results.push(await adapter.configure(registration, replace));
        continue;
      }
      if (mode === "remove") {
        results.push(await adapter.remove(registration));
        continue;
      }
      const inspected = await adapter.check(registration);
      if (inspected.status !== "healthy") {
        results.push(inspected);
        continue;
      }
      if (inspected.healthRegistration === undefined) {
        results.push({ client: inspected.client, status: "failed", detail: "Owned health registration is unavailable" });
        continue;
      }
      const health = await checkMcpRegistration(inspected.healthRegistration, runner);
      results.push(health.healthy
        ? { client: inspected.client, status: "healthy", detail: health.detail }
        : { client: inspected.client, status: "failed", detail: health.detail });
    } catch {
      results.push(failedHostOperation(adapter.id));
    }
  }
  return results;
}

function defaultDependencies(): SetupDependencies {
  return {
    runner: processRunner,
    platform: createPlatformServices(),
    adapters: [],
    confirmation: createConfirmationPort(),
  };
}

const defaultVoiceSkillServices: VoiceSkillServices = {
  resolveTargets: resolveVoiceSkillTargets,
  install(target, replace) {
    return installVoiceSkill(target, { replace });
  },
  check(target) {
    return checkVoiceSkill(target);
  },
  remove(target) {
    return removeVoiceSkill(target);
  },
};

function detectedVoiceSkillHosts(platform: PlatformServices): ReadonlySet<VoiceSkillTarget["host"]> {
  const hosts = new Set<VoiceSkillTarget["host"]>();
  try {
    if (platform.resolveExecutable("codex") !== undefined) hosts.add("codex");
  } catch {
    // Missing or unreadable client discovery is treated as undetected.
  }
  try {
    if (platform.resolveExecutable("claude") !== undefined) hosts.add("claude-code");
  } catch {
    // Missing or unreadable client discovery is treated as undetected.
  }
  return hosts;
}

async function invokeVoiceSkills(
  mode: SetupMode,
  targets: readonly VoiceSkillTarget[],
  replace: boolean,
  services: VoiceSkillServices,
): Promise<VoiceSkillOperationResult[]> {
  const results: VoiceSkillOperationResult[] = [];
  for (const target of targets) {
    try {
      results.push(mode === "configure"
        ? await services.install(target, replace)
        : mode === "check"
          ? await services.check(target)
          : await services.remove(target));
    } catch {
      results.push({
        host: target.host,
        status: "failed",
        detail: "Voice skill host operation failed",
      });
    }
  }
  return results;
}

function printVoiceSkillResult(result: VoiceSkillOperationResult): void {
  detail(`voice-skill ${result.host}: ${result.status}`);
  detail(result.detail);
  if (result.backupPath !== undefined && !result.detail.includes(result.backupPath)) {
    detail(`voice-skill backup: ${result.backupPath}`);
  }
}

function voiceSkillSucceeded(
  mode: SetupMode,
  results: readonly VoiceSkillOperationResult[],
): boolean {
  if (mode === "configure") {
    return results.every(({ status }) => status === "installed"
      || status === "unchanged"
      || status === "upgraded");
  }
  if (mode === "check") {
    return results.every(({ status }) => status === "unchanged");
  }
  return results.every(({ status }) => status === "removed" || status === "skipped");
}

export async function setup(argv: readonly string[], deps?: SetupDependencies): Promise<number> {
  let options;
  try {
    options = parseSetupArgs(argv);
  } catch (error) {
    if (error instanceof SetupUsageError) {
      say(`${error.message}. run rocky --help, question`);
      return 2;
    }
    throw error;
  }

  const dependencies = deps ?? defaultDependencies();
  let registration: McpRegistration;
  try {
    registration = resolveMcpRegistration({
      exposure: options.exposure,
      nodePath: dependencies.nodePath,
      entryPath: dependencies.entryPath,
      rockyHome: dependencies.rockyHome ?? process.env.ROCKY_HOME,
      home: dependencies.platform.home,
      fileExists: dependencies.platform.fileExists,
    });
  } catch {
    say("MCP registration paths are not usable. setup stops. bad.");
    return 1;
  }

  const entry = registration.args[0];
  if (entry === undefined || isEphemeralInstall(entry)) {
    say("ephemeral install cannot own durable host setup. install Rocky first.");
    return 1;
  }

  if (options.mode === "configure") {
    say("configured MCP host may forward selected projected memory.");
    if (options.exposure === "raw") {
      say("raw exposure includes working directories and stored stderr excerpts. bad bad if host shares them.");
    }
  }

  const adapters = deps === undefined
    ? await createProductionAdapters(dependencies.platform, dependencies.runner, registration)
    : dependencies.adapters;
  let results: SetupResult[] | undefined;
  let inspectionFailures: ReadonlyMap<SetupClientAdapter, SetupResult> = new Map();
  let skillWorkAuthorized = true;
  if (options.mode !== "check" && !options.yes) {
    const consent = await consentResults(
      options.mode,
      adapters,
      registration,
      dependencies.confirmation,
      options.voiceSkill,
    );
    results = consent.results;
    inspectionFailures = consent.inspectionFailures;
    if (consent.results !== undefined) skillWorkAuthorized = false;
  }
  results ??= await invokeAdapters(
    options.mode,
    adapters,
    registration,
    options.replace,
    dependencies.runner,
    inspectionFailures,
  );

  say("host setup results follow.");
  for (const result of results) printResult(options.mode, result, registration);

  let voiceResults: VoiceSkillOperationResult[] = [];
  if (options.voiceSkill && skillWorkAuthorized) {
    const services = dependencies.voiceSkills ?? defaultVoiceSkillServices;
    const detected = detectedVoiceSkillHosts(dependencies.platform);
    if (detected.size > 0) {
      const targets = services.resolveTargets(
        dependencies.env ?? process.env,
        dependencies.platform.home,
      ).filter((target) => detected.has(target.host));
      voiceResults = await invokeVoiceSkills(options.mode, targets, options.replace, services);
      for (const result of voiceResults) printVoiceSkillResult(result);
    }
  }

  if (options.mode === "configure"
    && dependencies.platform.shell !== undefined
    && basename(dependencies.platform.shell) === "bash"
    && !dependencies.platform.hasBashHook()) {
    detail("next step: rocky hook install");
  }

  const setupExit = exitCode(options.mode, results);
  return setupExit === 0 && voiceSkillSucceeded(options.mode, voiceResults) ? 0 : 1;
}
