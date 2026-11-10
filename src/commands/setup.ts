import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, join, posix, resolve, win32 } from "node:path";
import { configuredRockyHome } from "../core/state-paths.js";
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
import { MCP_HARNESS_IDS, createHarnessMcpAdapters } from "../setup/harness-mcp-dispatch.js";
import { checkMcpRegistration } from "../setup/health.js";
import { purgeRepoCapture, setRepoCapture } from "../listening/consent.js";
import { listeningStoreUsage } from "../listening/event-log-read.js";
import { getRepoConsentDetail } from "../listening/repo-consent-read.js";
import {
  LISTENING_DISK_BUDGET_BYTES_PER_REPO,
  PROPOSAL_MAX_EVENT_STORE_BYTES_PER_REPO,
  PROPOSAL_MAX_OBJECT_STORE_BYTES_PER_REPO,
} from "../listening/types.js";
import { SetupUsageError, parseSetupArgs } from "../setup/parser.js";
import { defaultAutoContext, runAutoSetup } from "../setup/auto/command.js";
import { createPlatformServices, type PlatformServices } from "../setup/platform.js";
import { processRunner, type ProcessRunner } from "../setup/process.js";
import { createPromptPort, type PromptInput } from "../setup/prompt.js";
import { runHarnessWizard, selectionsToSetupOptions, type HarnessWizardResult } from "../setup/harness-wizard.js";
import {
  agentHooksStatus,
  CLAUDE_CAPTURE_CAPABILITY_NOTICE,
  defaultAgentHooksEntryPath,
  defaultAgentHooksTarget,
  installClaudeAgentHooks,
  printCodexAgentHooks,
  rockyGateHookCommand,
  rockyHookCommand,
  uninstallClaudeAgentHooks,
  type AgentHooksTarget,
} from "../setup/agent-hooks.js";
import type { AgentHooksAction, HarnessId, RepoCaptureAction } from "../setup/clients.js";
import { installDeskHooks, uninstallDeskHooks } from "../setup/desk-hooks.js";
import {
  checkLegacyVoiceSkill,
  removeLegacyVoiceSkill,
  resolveLegacyVoiceSkillTargets,
  type LegacyVoiceSkillResult,
  type LegacyVoiceSkillTarget,
} from "../setup/legacy-voice-skill.js";
import {
  isEphemeralInstall,
  isIdenticalMcpRegistration,
  resolveMcpRegistration,
} from "../setup/registration.js";
import { detail, prompt, say } from "../ui/rocky.js";
import { safeTerminalBlock, safeTerminalLine } from "../ui/sanitize.js";

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
  /** Test override for the cleanup of a voice skill that older releases installed. */
  legacyVoiceSkills?: LegacyVoiceSkillServices;
  /** Test override; production defaults to process.stdin.isTTY. */
  isTTY?: boolean;
  /** Test override for the checkbox picker opened by bare `--harness`. */
  pickHarnesses?: () => Promise<HarnessWizardResult>;
}

export interface LegacyVoiceSkillServices {
  resolveTargets(env: NodeJS.ProcessEnv, home: string): readonly LegacyVoiceSkillTarget[];
  check(target: LegacyVoiceSkillTarget): Promise<LegacyVoiceSkillResult>;
  remove(target: LegacyVoiceSkillTarget): Promise<LegacyVoiceSkillResult>;
}

export function createConfirmationPort(
  input: PromptInput = process.stdin,
): ConfirmationPort {
  const port = createPromptPort(input, process.stderr);
  return {
    async confirm(message) {
      // prompt() ends with a space and confirm() appends its own " [y/N] ".
      return port.confirm(prompt(message).trimEnd());
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
  env: NodeJS.ProcessEnv = process.env,
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
      env,
      home: platform.home,
      platform: platform.platform,
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
    : ["mcp", "add", "--scope", "user", "--transport", "stdio", registration.name];
  for (const [name, value] of Object.entries(registration.env)) {
    args.push("--env", `${name}=${value}`);
  }
  if (client === "codex") args.push(registration.name);
  args.push("--", registration.command, ...registration.args);
  return args;
}

function printResult(mode: SetupMode, result: SetupResult, desired: McpRegistration): void {
  detail(`${safeTerminalLine(result.client)}: ${safeTerminalLine(result.status)}`);
  if (result.detail !== undefined) detail(safeTerminalBlock(result.detail));
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

function skippedFromInspection(
  client: SetupClientId,
  inspection: InspectionResult,
  mode: Exclude<SetupMode, "check">,
  registration: McpRegistration,
): SetupResult {
  if (inspection.state === "blocked") {
    return { client, status: "skipped", detail: inspection.detail };
  }
  if (inspection.state === "unreadable") {
    const result: SetupResult = {
      client,
      status: "failed",
      detail: inspection.detail ?? "Host registration cannot be read",
    };
    if (mode === "configure" && client === "codex") {
      result.manualRegistration = registration;
    }
    return result;
  }
  return { client, status: "requires-confirmation" };
}

function failedHostOperation(client: SetupClientId, detailMessage = "Host operation failed"): SetupResult {
  return { client, status: "failed", detail: detailMessage };
}

interface ConsentOutcome {
  results?: SetupResult[];
  inspectionFailures: ReadonlyMap<SetupClientAdapter, SetupResult>;
  // True only when a prompt was actually shown and answered no. "Nothing
  // needed a prompt" (every MCP adapter blocked or unreadable, and no legacy
  // voice skill to move) is a different state and must not be conflated with a
  // real decline: a decline withdraws the legacy cleanup and exits 1.
  declined: boolean;
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

function consentQuestion(
  mode: Exclude<SetupMode, "check">,
  mcpWork: boolean,
  legacyHosts: readonly LegacyVoiceSkillTarget["host"][],
): string {
  if (mode === "configure") return "Configure MCP hosts now?";
  const legacy = `the legacy voice skill (${legacyHosts.join(", ")})`;
  if (!mcpWork) return `Remove ${legacy} now?`;
  return legacyHosts.length === 0
    ? "Remove rocky from MCP hosts now?"
    : `Remove rocky from MCP hosts and ${legacy} now?`;
}

async function consentResults(
  mode: Exclude<SetupMode, "check">,
  adapters: readonly SetupClientAdapter[],
  registration: McpRegistration,
  confirmation: ConfirmationPort,
  legacyHosts: readonly LegacyVoiceSkillTarget["host"][],
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
      : skippedFromInspection(adapter.id, inspection, mode, registration);
  });
  // Consent must cover every mutation setup() is about to attempt, not just
  // the MCP adapters. A managed legacy voice skill that --remove will move to
  // backup is real pending work exactly like a non-blocked MCP adapter, so it
  // forces a prompt too. Otherwise a machine with every MCP adapter blocked
  // would lose the skill without a prompt ever being shown.
  const mcpWork = [...inspections.values()].some((inspection) => inspection.state !== "blocked"
    && inspection.state !== "unreadable");
  if (!mcpWork && legacyHosts.length === 0) {
    return { results: orderedResults(), inspectionFailures, declined: false };
  }
  const allowed = await confirmation.confirm(consentQuestion(mode, mcpWork, legacyHosts));
  if (allowed) return { inspectionFailures, declined: false };
  const instruction = mode === "configure" ? "rocky setup --yes" : "rocky setup --remove --yes";
  const results = orderedResults();
  for (const result of results) {
    if (result.status === "requires-confirmation") {
      result.detail = `Confirmation required; rerun with ${instruction}`;
    }
  }
  return { results, inspectionFailures, declined: true };
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

const MIB = 1024 * 1024;

function mib(bytes: number): string {
  return `${Number((bytes / MIB).toFixed(1))} MiB`;
}

function reportStoreUsage(root: string, allowed: boolean, home: string | undefined): void {
  const usage = listeningStoreUsage(root, home);
  const held = usage.eventsBytes + usage.objectsBytes;
  detail(`disk ${mib(held)} of ${mib(LISTENING_DISK_BUDGET_BYTES_PER_REPO)} budget`);
  detail(`events ${mib(usage.eventsBytes)}, snapshots ${mib(usage.objectsBytes)} in ${usage.objects} file${usage.objects === 1 ? "" : "s"}`);
  if (!allowed && held > 0) detail(`History is still held. Delete it with: rocky setup --repo ${root} --purge-capture`);
}

async function runPurgeCapture(
  repo: string,
  probe: { allowed: boolean; root: string },
  yes: boolean,
  confirmation: ConfirmationPort,
  home: string | undefined,
): Promise<number> {
  const held = listeningStoreUsage(probe.root, home);
  say(`Purge deletes the listening history for this repo (${mib(held.eventsBytes + held.objectsBytes)}). There is no undo.`);
  if (!yes && !(await confirmation.confirm("Purge the listening history for this repo now?"))) {
    say("Consent withheld. Setup stopped and nothing changed.");
    return 1;
  }
  const purged = purgeRepoCapture(repo, { yes: true, actor: "cli", onRevoke: "delete" }, home);
  if (!purged.ok) {
    detail(purged.reason ?? "Purge failed.");
    return 1;
  }
  if (probe.allowed) detail(`capture revoked: ${purged.root ?? probe.root}`);
  detail(`history purged: ${mib(purged.freedBytes)} freed`);
  return 0;
}

async function runRepoCaptureAction(
  repo: string,
  action: RepoCaptureAction,
  yes: boolean,
  confirmation: ConfirmationPort,
  home: string | undefined,
): Promise<number> {
  // Relative --repo means relative to cwd. Revoke and purge still accept a
  // path that is gone, so a stale consent stays removable.
  const target = resolve(repo);
  if (!existsSync(target) && (action === "allow-capture" || action === "check-capture")) {
    say("Setup stopped: the repo path does not exist.");
    detail(`Path: ${target}`);
    return 2;
  }
  const probe = getRepoConsentDetail(target, home);
  if (probe.root.length === 0) {
    say("Setup stopped: the repo path does not resolve.");
    return 2;
  }
  detail(`Canonical repo root: ${probe.root}`);
  if (action === "check-capture") {
    detail(probe.allowed ? "capture allowed" : "capture off");
    reportStoreUsage(probe.root, probe.allowed, home);
    return 0;
  }
  if (action === "purge-capture") return runPurgeCapture(target, probe, yes, confirmation, home);
  say("Snapshot text is bounded and redacted, but a secret may remain in it. If a host shares that text, the secret is shared too.");
  say("Sanitized MCP metadata may list repo and file names. Nothing is sent by rocky itself.");
  if (action === "allow-capture") {
    say(
      `Disk budget per repo is ${mib(LISTENING_DISK_BUDGET_BYTES_PER_REPO)}: events ${mib(PROPOSAL_MAX_EVENT_STORE_BYTES_PER_REPO)}, `
        + `snapshots ${mib(PROPOSAL_MAX_OBJECT_STORE_BYTES_PER_REPO)}. When the budget is full, the oldest data is pruned first.`,
    );
  }
  if (!yes) {
    const allowed = await confirmation.confirm(
      action === "allow-capture" ? "Allow capture for this repo now?" : "Revoke capture for this repo now?",
    );
    if (!allowed) {
      say("Consent withheld. Setup stopped and nothing changed.");
      return 1;
    }
  }
  const result = setRepoCapture(target, action === "allow-capture", { yes: true, actor: "cli", onRevoke: "delete" }, home);
  if (!result.ok) {
    detail(result.reason ?? "Capture action failed.");
    return result.reason === "requires-confirmation" ? 2 : 1;
  }
  detail(action === "allow-capture" ? `capture allowed: ${result.root ?? probe.root}` : `capture revoked: ${result.root ?? probe.root}`);
  if (action === "revoke-capture") {
    detail("History is kept. Revoking stops new capture only.");
    // The listening store is per worktree, so purge must name the path given
    // here; the decision root may be the main repository instead.
    detail(`Delete it with: rocky setup --repo ${target} --purge-capture`);
  }
  return 0;
}

const CLAUDE_CONFIG_DIR_EMPTY =
  "Setup stopped: CLAUDE_CONFIG_DIR is set but empty. Unset it or set an absolute directory path.";
const CLAUDE_CONFIG_DIR_UNUSABLE =
  "Setup stopped: CLAUDE_CONFIG_DIR must be a normalized absolute directory path (no trailing separator, no . or .. segments, native path separators).";

/**
 * Resolve the Claude settings file once per action. A refused value is
 * reported here, before any prompt, and the caller exits 1 on `undefined`. The
 * resolved path is printed so the owner sees which profile receives the hooks.
 */
function resolveClaudeSettingsTarget(dependencies: SetupDependencies): AgentHooksTarget | undefined {
  const resolution = defaultAgentHooksTarget(
    dependencies.platform.home,
    dependencies.env ?? process.env,
    process.cwd(),
  );
  if (resolution.status === "refused") {
    say(resolution.reason === "empty" ? CLAUDE_CONFIG_DIR_EMPTY : CLAUDE_CONFIG_DIR_UNUSABLE);
    return undefined;
  }
  detail(safeTerminalBlock(`claude-code settings: ${resolution.target.settingsPath}`));
  return resolution.target;
}

/**
 * Printed when --yes accompanies a hook install. Those installs always ask in
 * a terminal and --yes is not the answer, so a run without a terminal installs
 * nothing. The note says so instead of leaving a silent decline.
 */
export const HOOK_INSTALL_YES_NOTE =
  "--yes does not answer the hook install question. Run this command in a terminal to confirm.";

async function runAgentHooksAction(
  action: AgentHooksAction,
  yes: boolean,
  dependencies: SetupDependencies,
  rationaleGate: boolean,
  harnesses: readonly HarnessId[],
): Promise<number> {
  const nodeCandidate = dependencies.nodePath ?? process.execPath;
  const entryCandidate = dependencies.entryPath ?? defaultAgentHooksEntryPath();
  try {
    // Dedicated agent-hook setup is deliberately independent from MCP
    // registration. Validate injected paths here so tests and production both
    // refuse a relative, missing, or ephemeral script before consent/output.
    // Validate the spelling before realpath resolution. Otherwise an
    // existing relative candidate could become absolute and evade the pure
    // command builder's path boundary.
    rockyHookCommand("claude-code", nodeCandidate, entryCandidate);
    const resolveInstalledPath = (candidate: string): string => {
      if (!posix.isAbsolute(candidate) && !win32.isAbsolute(candidate)) {
        throw new Error("path must be absolute");
      }
      if (!dependencies.platform.fileExists(candidate)) throw new Error("missing path");
      const resolved = realpathSync(candidate);
      const metadata = lstatSync(resolved);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("path is not a file");
      if (isEphemeralInstall(resolved)) throw new Error("path is ephemeral");
      return resolved;
    };
    const nodePath = resolveInstalledPath(nodeCandidate);
    const entryPath = resolveInstalledPath(entryCandidate);
    const command = rockyHookCommand("claude-code", nodePath, entryPath);
    const codexCommand = rockyHookCommand("codex", nodePath, entryPath);
    const gateCommand = rockyGateHookCommand(nodePath, entryPath);
    const target = resolveClaudeSettingsTarget(dependencies);
    if (target === undefined) return 1;
    const options = {
      command,
      // Install treats this as an explicit on/off switch (--no-rationale-gate
      // omits it); uninstall ignores it; status always validates against the
      // canonical gate command regardless of this run's install choice,
      // since it must recognize both installed shapes as current.
      gateCommand: action === "install" && !rationaleGate ? undefined : gateCommand,
      confirmation: dependencies.confirmation,
      detail,
    };
    if (action === "install" || action === "status") {
      detail(CLAUDE_CAPTURE_CAPABILITY_NOTICE);
    }
    if (action === "install") {
      if (yes) detail(HOOK_INSTALL_YES_NOTE);
      const result = await installClaudeAgentHooks(target, options);
      detail(`claude-code agent hooks: ${result.status}`);
      if (result.detail !== undefined) detail(safeTerminalBlock(result.detail));
      printCodexAgentHooks(codexCommand);
      return result.status === "written" || result.status === "unchanged" ? 0 : 1;
    }
    if (action === "uninstall") {
      const result = await uninstallClaudeAgentHooks(target, options);
      detail(`claude-code agent hooks: ${result.status}`);
      if (result.detail !== undefined) detail(safeTerminalBlock(result.detail));
      detail("codex agent hooks: manual (config.toml unchanged)");
      return result.status === "written" || result.status === "unchanged" ? 0 : 1;
    }
    const result = agentHooksStatus(target, options);
    detail("Setup status scope: host/MCP registration via rocky setup --check and agent-hook state/capability; spool and Ollama/model health are not checked.");
    detail(`claude-code agent hooks: ${result.claudeCode}`);
    detail("codex agent hooks: manual");
    await reportLegacyVoiceSkill(harnesses, dependencies);
    return result.claudeCode === "unreadable" ? 1 : 0;
  } catch {
    say("Setup stopped: the Claude Code agent hook paths are not usable.");
    return 1;
  }
}

async function runDeskHooksAction(
  action: "install" | "uninstall",
  hookBin: string | undefined,
  yes: boolean,
  dependencies: SetupDependencies,
): Promise<number> {
  try {
    if (action === "install") {
      if (hookBin === undefined) {
        say("Setup stopped: --desk-hooks needs the rocky-hook path.");
        return 2;
      }
      if (!posix.isAbsolute(hookBin) && !win32.isAbsolute(hookBin)) {
        say("Setup stopped: the desk hook path must be absolute.");
        return 1;
      }
      if (!dependencies.platform.fileExists(hookBin)) {
        say("Setup stopped: the desk hook path does not exist.");
        return 1;
      }
      const resolved = realpathSync(hookBin);
      const actual = basename(resolved);
      const lowered = actual.toLowerCase();
      const named = process.platform === "win32"
        ? lowered === "rocky-hook" || lowered === "rocky-hook.exe"
        : actual === "rocky-hook" || actual === "rocky-hook.exe";
      if (!named) {
        say("Setup stopped: the desk hook path must be the rocky-hook binary.");
        return 1;
      }
      const target = resolveClaudeSettingsTarget(dependencies);
      if (target === undefined) return 1;
      if (yes) detail(HOOK_INSTALL_YES_NOTE);
      const result = await installDeskHooks(target, {
        hookBin: resolved,
        fileExists: (path) => dependencies.platform.fileExists(path) || path === resolved,
        confirmation: dependencies.confirmation,
        detail,
      });
      detail(`claude-code desk hooks: ${result.status}`);
      if (result.detail !== undefined) detail(safeTerminalBlock(result.detail));
      return result.status === "written" || result.status === "unchanged" ? 0 : 1;
    }
    const target = resolveClaudeSettingsTarget(dependencies);
    if (target === undefined) return 1;
    const result = await uninstallDeskHooks(target, {
      confirmation: dependencies.confirmation,
      detail,
    });
    detail(`claude-code desk hooks: ${result.status}`);
    if (result.detail !== undefined) detail(safeTerminalBlock(result.detail));
    return result.status === "written" || result.status === "unchanged" ? 0 : 1;
  } catch {
    say("Setup stopped: the Claude Code desk hook paths are not usable.");
    return 1;
  }
}

/*
 * Legacy voice skill. Older releases could install a voice skill with
 * the retired voice skill flag. rocky no longer ships it, so setup only cleans up a
 * copy left behind: --check and --status report it read-only, and --remove
 * moves an unmodified managed copy into a backup folder after the same consent
 * as the MCP removal. A decline never touches it. When no legacy skill exists
 * nothing is printed and no exit code changes.
 */
const defaultLegacyVoiceSkillServices: LegacyVoiceSkillServices = {
  resolveTargets: resolveLegacyVoiceSkillTargets,
  check: (target) => checkLegacyVoiceSkill(target),
  remove: (target) => removeLegacyVoiceSkill(target),
};

/**
 * The legacy skill folders belong to Codex and Claude Code. With explicit
 * --harness targets only the selected hosts are looked at, so removing one
 * host never touches another host's files.
 */
function legacyTargetsFor(
  harnesses: readonly HarnessId[],
  dependencies: SetupDependencies,
  services: LegacyVoiceSkillServices,
): readonly LegacyVoiceSkillTarget[] {
  const targets = services.resolveTargets(dependencies.env ?? process.env, dependencies.platform.home);
  return harnesses.length === 0 ? targets : targets.filter((target) => harnesses.includes(target.host));
}

async function runLegacyVoiceSkill(
  operation: "check" | "remove",
  target: LegacyVoiceSkillTarget,
  services: LegacyVoiceSkillServices,
): Promise<LegacyVoiceSkillResult> {
  try {
    return await services[operation](target);
  } catch {
    return { host: target.host, status: "failed", detail: "unexpected error" };
  }
}

interface CheckedLegacyTarget {
  target: LegacyVoiceSkillTarget;
  checked: LegacyVoiceSkillResult;
}

async function checkLegacyTargets(
  targets: readonly LegacyVoiceSkillTarget[],
  services: LegacyVoiceSkillServices,
): Promise<CheckedLegacyTarget[]> {
  const entries: CheckedLegacyTarget[] = [];
  for (const target of targets) {
    entries.push({ target, checked: await runLegacyVoiceSkill("check", target, services) });
  }
  return entries;
}

/**
 * Remove only what the read-only check found installed. Every other state
 * (absent, modified, refused, failed) is reported as the check saw it, so a
 * tree that was not seen as managed, and consented to, is never moved.
 */
async function removeCheckedLegacyTargets(
  entries: readonly CheckedLegacyTarget[],
  services: LegacyVoiceSkillServices,
): Promise<LegacyVoiceSkillResult[]> {
  const results: LegacyVoiceSkillResult[] = [];
  for (const { target, checked } of entries) {
    results.push(checked.status === "installed"
      ? await runLegacyVoiceSkill("remove", target, services)
      : checked);
  }
  return results;
}

/** One line per target that had a legacy skill; absent targets print nothing. */
function printLegacyVoiceSkillResults(results: readonly LegacyVoiceSkillResult[]): void {
  for (const result of results) {
    if (result.status === "absent") continue;
    detail(`legacy voice skill ${safeTerminalLine(result.host)}: ${result.status}; ${safeTerminalLine(result.detail)}`);
  }
}

async function reportLegacyVoiceSkill(
  harnesses: readonly HarnessId[],
  dependencies: SetupDependencies,
): Promise<void> {
  const services = dependencies.legacyVoiceSkills ?? defaultLegacyVoiceSkillServices;
  const targets = legacyTargetsFor(harnesses, dependencies, services);
  const entries = await checkLegacyTargets(targets, services);
  printLegacyVoiceSkillResults(entries.map(({ checked }) => checked));
}

/** Parser messages are lowercase error text; the printed line is a sentence with a next step. */
function usageMessage(message: string): string {
  const sentence = message.charAt(0).toUpperCase() + message.slice(1);
  return `${sentence.replace(/\.$/u, "")}. Run rocky --help --all to list every option.`;
}

export async function setup(argv: readonly string[], deps?: SetupDependencies): Promise<number> {
  if (argv[0] === "--auto") {
    // Hidden, prompt-free entry for the desktop app: one JSON object on
    // stdout, no parser, no prompt, and no harness executable.
    return runAutoSetup(argv.slice(1), defaultAutoContext, (json) => process.stdout.write(`${json}\n`));
  }
  let options;
  try {
    options = parseSetupArgs(argv);
  } catch (error) {
    if (error instanceof SetupUsageError) {
      say(usageMessage(error.message));
      return 2;
    }
    throw error;
  }

  // Explicit test doubles carry isTTY; legacy doubles omit it and default to
  // interactive (deviation from plan line 909: plan-form `?? process.stdin...`
  // breaks 40 legacy setup-command tests written for the TTY-true default).
  // Production (deps undefined) reads the real stdin TTY state, so the
  // non-TTY guard still fires for piped/redirected stdin.
  const stdinTTY = deps?.isTTY ?? (deps === undefined ? process.stdin.isTTY ?? false : true);
  const dependencies = deps ?? defaultDependencies();
  if (options.repoAction !== undefined && options.repo !== undefined) {
    return runRepoCaptureAction(options.repo, options.repoAction, options.yes, dependencies.confirmation, dependencies.rockyHome);
  }
  if (options.rawTrace) {
    say("Setup stopped: raw trace grants are not wired yet.");
    detail("Setup only parses --raw-trace for now; grant storage lands with the raw-trace milestone.");
    return 1;
  }
  if (options.wizard === true) {
    if (!stdinTTY) {
      say("Setup stopped: the harness picker needs an interactive terminal.");
      detail("Example: rocky setup --harness codex --yes (MCP only)");
      return 2;
    }
    const picked = await (dependencies.pickHarnesses ?? (() => runHarnessWizard(createPromptPort(), undefined, MCP_HARNESS_IDS)))();
    if (picked.cancelled) {
      say("No harness chosen. Nothing changed.");
      return 1;
    }
    options = selectionsToSetupOptions(options, picked.selections);
    if (options.listening) {
      detail("Per-harness listening is not wired into setup yet. Use rocky setup --repo <path> --allow-capture.");
    }
    if (options.harnesses.length === 0) {
      say("Setup stopped: no MCP host chosen.");
      return 1;
    }
  }
  if (!stdinTTY && options.harnesses.length === 0 && options.agentHooksAction === undefined && options.deskHooksAction === undefined) {
    say("Setup stopped: explicit harness targets are now required.");
    detail("Example: rocky setup --harness codex --yes (MCP only)");
    detail("Example: rocky setup --harness codex --listening --yes (Listening)");
    detail("A broad setup without --harness no longer configures hosts.");
    return 2;
  }

  if (options.deskHooksAction !== undefined) {
    return runDeskHooksAction(options.deskHooksAction, options.deskHookBin, options.yes, dependencies);
  }
  if (options.agentHooksAction !== undefined) {
    return runAgentHooksAction(
      options.agentHooksAction,
      options.yes,
      dependencies,
      options.rationaleGate ?? true,
      options.harnesses,
    );
  }

  let registration: McpRegistration;
  try {
    registration = resolveMcpRegistration({
      exposure: options.exposure,
      nodePath: dependencies.nodePath,
      entryPath: dependencies.entryPath,
      rockyHome: dependencies.rockyHome ?? configuredRockyHome(process.env),
      home: dependencies.platform.home,
      fileExists: dependencies.platform.fileExists,
    });
  } catch {
    say("Setup stopped: the MCP registration paths are not usable.");
    return 1;
  }

  const entry = registration.args[0];
  if (entry === undefined || isEphemeralInstall(entry)) {
    say("An ephemeral install cannot own durable host setup. Install rocky first.");
    return 1;
  }

  if (options.mode === "configure") {
    say("A configured MCP host may forward selected projected memory.");
    if (options.exposure === "raw") {
      say("Raw exposure includes working directories and stored stderr excerpts. A host that shares them exposes that data.");
    }
  }

  const harnessAdapters = options.harnesses.length > 0 && options.mcp
    ? createHarnessMcpAdapters(options.harnesses, {
      runner: dependencies.runner,
      platform: dependencies.platform,
      env: dependencies.env ?? process.env,
      home: dependencies.platform.home,
    })
    : undefined;
  const adapters = harnessAdapters
    ?? (deps === undefined
      ? await createProductionAdapters(
        dependencies.platform,
        dependencies.runner,
        registration,
        dependencies.env ?? process.env,
      )
      : dependencies.adapters);
  let results: SetupResult[] | undefined;
  let inspectionFailures: ReadonlyMap<SetupClientAdapter, SetupResult> = new Map();
  let declined = false;
  // A read-only look at the legacy voice skill folders. --check reports what
  // it finds; --remove also uses it to learn whether the consent prompt has to
  // cover moving a managed copy into a backup folder.
  const legacyServices = dependencies.legacyVoiceSkills ?? defaultLegacyVoiceSkillServices;
  const legacyEntries = options.mode === "configure"
    ? []
    : await checkLegacyTargets(legacyTargetsFor(options.harnesses, dependencies, legacyServices), legacyServices);
  if (options.mode !== "check" && !options.yes) {
    const legacyHosts = options.mode === "remove"
      ? legacyEntries.filter(({ checked }) => checked.status === "installed").map(({ target }) => target.host)
      : [];
    const consent = await consentResults(
      options.mode,
      adapters,
      registration,
      dependencies.confirmation,
      legacyHosts,
    );
    results = consent.results;
    inspectionFailures = consent.inspectionFailures;
    declined = consent.declined;
  }
  results ??= await invokeAdapters(
    options.mode,
    adapters,
    registration,
    options.replace,
    dependencies.runner,
    inspectionFailures,
  );

  say("Host setup results follow.");
  for (const result of results) printResult(options.mode, result, registration);

  // Only --remove mutates the legacy skill, and a decline leaves it alone: the
  // lines then repeat what the read-only check saw. --check never needs consent
  // for the same reason MCP check does not; a read has nothing to authorize.
  const legacyResults = options.mode === "remove" && !declined
    ? await removeCheckedLegacyTargets(legacyEntries, legacyServices)
    : legacyEntries.map(({ checked }) => checked);
  printLegacyVoiceSkillResults(legacyResults);

  if (options.mode === "configure"
    && dependencies.platform.shell !== undefined
    && basename(dependencies.platform.shell) === "bash"
    && !dependencies.platform.hasBashHook()) {
    detail("Next step: rocky hook install");
  }

  // The exit code certifies the MCP work. A legacy skill that rocky refuses to
  // touch (edited, unmarked, unsafe) is reported but does not fail the run; an
  // unexpected failure to move a managed copy does.
  const legacyFailed = options.mode === "remove" && legacyResults.some(({ status }) => status === "failed");
  return exitCode(options.mode, results) === 0 && !declined && !legacyFailed ? 0 : 1;
}
