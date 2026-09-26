import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  InspectionResult,
  McpRegistration,
  SetupClientAdapter,
  SetupResult,
} from "./clients.js";
import type { PlatformServices } from "./platform.js";
import type { ProcessRunner } from "./process.js";
import { atomicWriteBytesIfUnchanged, pathExists } from "./file-transaction.js";
import {
  notFoundDetection,
  resolveCanonicalExecutable,
  verifyMcpAfterWrite,
} from "./harness-mcp-shared.js";

export interface HarnessCodexDeps {
  runner: ProcessRunner;
  platform: PlatformServices;
  env?: NodeJS.ProcessEnv;
  home?: string;
  codexHome?: string;
}

const MISSING_DETAIL = "Codex CLI is not installed";
const VERSION_TIMEOUT_MS = 5_000;
const LIST_TIMEOUT_MS = 10_000;
const ROCKY_SECTION = "[mcp_servers.rocky]";

function resolveCodexHome(deps: HarnessCodexDeps): string {
  const env = deps.env ?? process.env;
  if (deps.codexHome !== undefined) return deps.codexHome;
  if (typeof env.CODEX_HOME === "string" && env.CODEX_HOME.length > 0) return env.CODEX_HOME;
  return join(deps.home ?? deps.platform.home, ".codex");
}

async function executablePath(deps: HarnessCodexDeps): Promise<string | undefined> {
  const { executable } = await resolveCanonicalExecutable({
    runner: deps.runner,
    platform: deps.platform,
    names: ["codex"],
    versionArgs: ["--version"],
    timeoutMs: VERSION_TIMEOUT_MS,
  });
  if (executable === undefined) return undefined;
  return executable.path;
}

async function nativeListShows(
  deps: HarnessCodexDeps,
  executable: string,
): Promise<"rocky" | "other" | "unreachable"> {
  try {
    const result = await deps.runner.run(executable, ["mcp", "list"], { timeoutMs: LIST_TIMEOUT_MS });
    if (result.status !== 0 || result.error !== undefined) return "unreachable";
    const observed = `${result.stdout}\n${result.stderr}`;
    return observed.includes("rocky") ? "rocky" : "other";
  } catch {
    return "unreachable";
  }
}

interface TomlBlock {
  status: "absent" | "owned" | "foreign" | "malformed";
  start: number;
  end: number;
}

function scanRockyBlock(lines: string[]): TomlBlock {
  const start = lines.findIndex((line) => line.trim() === ROCKY_SECTION);
  if (start === -1) return { status: "absent", start: -1, end: -1 };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[.*\]\s*$/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start + 1, end).join("\n");
  if (/=\s*["']?\s*$/.test(body) || /^\s*\[mcp_servers\.rocky[^\]]/.test(body)) {
    return { status: "malformed", start, end };
  }
  const commandLine = lines.slice(start + 1, end).find((line) => /^\s*command\s*=/.test(line));
  if (commandLine === undefined) return { status: "foreign", start, end };
  return { status: commandLine.includes("rocky") || commandLine.includes("node") ? "owned" : "foreign", start, end };
}

function desiredBlock(registration: McpRegistration): string[] {
  const lines = [ROCKY_SECTION, `command = ${JSON.stringify(registration.command)}`];
  lines.push(`args = [${registration.args.map((a) => JSON.stringify(a)).join(", ")}]`);
  for (const [k, v] of Object.entries(registration.env)) {
    lines.push(`env_${k} = ${JSON.stringify(v)}`);
  }
  return lines;
}

function blockMatchesRegistration(block: TomlBlock, text: string, registration: McpRegistration): boolean {
  if (block.status !== "owned") return false;
  const actual = text.split("\n").slice(block.start, block.end).join("\n").trimEnd();
  return actual === desiredBlock(registration).join("\n");
}

export function createHarnessCodexAdapter(deps: HarnessCodexDeps): SetupClientAdapter {
  const codexHome = resolveCodexHome(deps);
  const configPath = join(codexHome, "config.toml");

  function readToml(): { text: string } | { error: "missing" | "unreadable" } {
    if (!pathExists(configPath)) return { error: "missing" };
    try {
      return { text: readFileSync(configPath, "utf8") };
    } catch {
      return { error: "unreadable" };
    }
  }

  async function inspectWithNative(
    registration: McpRegistration,
  ): Promise<InspectionResult> {
    const exe = await executablePath(deps);
    if (exe === undefined) return { state: "blocked", detail: MISSING_DETAIL };
    const seen = await nativeListShows(deps, exe);
    const file = readToml();
    if ("text" in file) {
      const block = scanRockyBlock(file.text.split("\n"));
      if (block.status === "malformed") return { state: "unreadable", detail: `Codex config is unreadable: ${configPath}` };
      if (block.status === "foreign") return { state: "conflict", detail: "Codex already has a different rocky registration" };
      if (block.status === "owned" && !blockMatchesRegistration(block, file.text, registration)) {
        return { state: "conflict", detail: "Codex already has a different rocky registration" };
      }
    } else if (file.error === "unreadable") {
      return { state: "unreadable", detail: `Codex config is unreadable: ${configPath}` };
    }
    if (seen === "rocky") return { state: "identical" };
    if (seen === "unreachable") return { state: "unreadable", detail: "Codex app-server provenance and CAS capability is unavailable" };
    return { state: "absent" };
  }

  async function writeBlock(block: TomlBlock, text: string, registration: McpRegistration, remove: boolean): Promise<boolean> {
    const lines = text.split("\n");
    const next = remove
      ? [...lines.slice(0, block.start), ...lines.slice(block.end)]
      : block.status === "absent"
        ? [...lines, ...(lines.length > 0 && lines[lines.length - 1] !== "" ? [""] : []), ...desiredBlock(registration)]
        : [...lines.slice(0, block.start), ...desiredBlock(registration), ...lines.slice(block.end)];
    const prior = pathExists(configPath)
      ? { status: "valid" as const, bytes: Buffer.from(text, "utf8") }
      : { status: "missing" as const };
    const outcome = atomicWriteBytesIfUnchanged(configPath, Buffer.from(`${next.join("\n")}\n`, "utf8"), prior);
    return outcome.status === "written";
  }

  return {
    id: "codex",
    inspect(registration) {
      return inspectWithNative(registration);
    },
    async configure(registration, replace): Promise<SetupResult> {
      const exe = await executablePath(deps);
      if (exe === undefined) {
        void notFoundDetection("codex", ["codex"], configPath);
        return { client: "codex", status: "skipped", detail: MISSING_DETAIL };
      }
      const inspection = await inspectWithNative(registration);
      if (inspection.state === "unreadable") return { client: "codex", status: "failed", detail: inspection.detail };
      if (inspection.state === "identical") return { client: "codex", status: "already-configured" };
      if (inspection.state === "conflict" && !replace) {
        return { client: "codex", status: "requires-confirmation", detail: inspection.detail, manualRegistration: registration };
      }
      const file = readToml();
      const text = file !== undefined && "text" in file ? file.text : "";
      const block = scanRockyBlock(text === "" ? [] : text.split("\n"));
      if (block.status === "malformed") {
        return { client: "codex", status: "failed", detail: `Codex config is unreadable: ${configPath}` };
      }
      if (block.status === "foreign") {
        return { client: "codex", status: "failed", detail: "refusing to replace a rocky entry not owned by Rocky; resolve manually" };
      }
      const ok = await writeBlock(block, text, registration, false);
      if (!ok) return { client: "codex", status: "failed", detail: "Codex write stopped before mutation; target unchanged" };
      const outcome = await verifyMcpAfterWrite({
        runner: deps.runner,
        registration,
        listCommand: { command: exe, args: ["mcp", "list"], timeoutMs: LIST_TIMEOUT_MS },
        mustContain: "rocky",
      });
      if (!outcome.verified) {
        return { client: "codex", status: "failed", detail: `configured; MCP unverified: ${outcome.detail}` };
      }
      return { client: "codex", status: "configured" };
    },
    async remove(registration): Promise<SetupResult> {
      const exe = await executablePath(deps);
      if (exe === undefined) return { client: "codex", status: "skipped", detail: MISSING_DETAIL };
      const file = readToml();
      if ("error" in file && file.error === "missing") return { client: "codex", status: "not-configured" };
      if (!("text" in file)) {
        return { client: "codex", status: "failed", detail: `Codex config is unreadable: ${configPath}` };
      }
      const block = scanRockyBlock(file.text.split("\n"));
      if (block.status === "absent") return { client: "codex", status: "not-configured" };
      if (block.status === "malformed") {
        return { client: "codex", status: "failed", detail: `Codex config is unreadable: ${configPath}` };
      }
      if (block.status === "foreign") {
        return { client: "codex", status: "failed", detail: "refusing to remove a rocky entry not owned by Rocky" };
      }
      const ok = await writeBlock(block, file.text, registration, true);
      if (!ok) return { client: "codex", status: "failed", detail: "Codex removal stopped before mutation; target unchanged" };
      void exe;
      return { client: "codex", status: "removed" };
    },
    async check(registration): Promise<SetupResult> {
      const exe = await executablePath(deps);
      if (exe === undefined) return { client: "codex", status: "skipped", detail: MISSING_DETAIL };
      const seen = await nativeListShows(deps, exe);
      if (seen === "rocky") return { client: "codex", status: "healthy", healthRegistration: registration };
      if (seen === "unreachable") {
        return { client: "codex", status: "failed", detail: "Codex app-server provenance and CAS capability is unavailable", manualRegistration: registration };
      }
      return { client: "codex", status: "not-configured" };
    },
  };
}
