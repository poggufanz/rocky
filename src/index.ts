#!/usr/bin/env node
/**
 * rocky — a blind Eridian engineer who lives in your terminal.
 *
 * Public surface:
 *   rocky run "<command>"     run a command; Rocky remembers failures & fixes
 *   rocky recall [--ai] <query> search Rocky's memory of past errors
 *   rocky hook|mcp|model|setup distribution bridge commands
 *   rocky watch|check|what|how|why|digest|quiz|export v0.3–v0.5 surfaces
 *   rocky --help
 *   rocky --version
 */

import { run } from "./commands/run.js";
import { watch } from "./commands/watch.js";
import { recall } from "./commands/recall.js";
import { model } from "./commands/model.js";
import { stats } from "./commands/stats.js";
import { hookFail, hookInstall, hookStatus, hookSuccess, hookUninstall } from "./commands/hook.js";
import { mcp } from "./commands/mcp.js";
import { setup } from "./commands/setup.js";
import { check } from "./commands/check.js";
import { digest, exportCommand, how, quiz, what, why } from "./commands/dictionary.js";
import { agentEvent } from "./commands/agent-hook.js";
import { annotateCommand } from "./agent/annotate.js";
import { ambiguityCommand } from "./agent/ambiguity.js";
import { CliUsageError, parseExactCommand, reportCliUsage } from "./commands/cli-args.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./core/package-info.js";
import { detail, face, say } from "./ui/rocky.js";

const HELP = `
rocky — he remembers, so you don't have to.

install:
  npm install -g ${PACKAGE_NAME}

usage:
  rocky run "<command>"     run command through Rocky. failures are remembered;
                            when the same error returns, Rocky tells you what
                            fixed it last time.
  rocky watch "<command>" [--quiet]
                            run a long command; Rocky waits, remembers failures
                            the same way run does, saves the stderr tail on
                            failure, and knocks (desktop notification, or a
                            bell) when it finishes. --quiet: plain facts on
                            stderr only, no persona lines, no notification.
  rocky recall [--] <query...>
                            ask Rocky's memory. matches words from error or command.
  rocky recall --ai [--] <query...>
                            --ai asks configured local Ollama after deterministic recall.
  rocky what [--ai] [--] <query...>
                            look up what remembered intent became.
  rocky how [--] <query...> remember how intent became code.
  rocky why [--] <file>     hear why remembered change touched file.
  rocky digest              hear this week's remembered intent pattern.
  rocky quiz                practice remembered intent. Rocky asks, then reveals.
  rocky export [--kind failure|fix|note|triple] [--since ISO|Nd]
                            dump raw memory as JSONL on stdout.
  rocky model status         report local-AI configuration without loading a model.
  rocky model use [--exposure sanitized|raw] <installed-model>
                            probe an installed Ollama model, then enable local AI.
  rocky model off            disable Rocky local AI. Ollama stays untouched.
  rocky stats               what Rocky holds in memory.
  rocky mcp                 serve read-only memory tools over stdio.
  rocky setup               configure detected MCP hosts with sanitized exposure.
  rocky setup --check       verify owned host registrations and Rocky MCP tools.
  rocky setup --remove      remove owned Rocky registrations from detected hosts.
  rocky setup --replace     replace conflicting registrations after confirmation.
  rocky setup --mcp-exposure sanitized|raw
                            choose projected-memory exposure during configure.
  rocky setup --voice-skill configure hosts and install managed voice skill explicitly.
  rocky setup --agent-hooks
                            install Claude Code hooks after explicit consent; print Codex TOML.
  rocky setup --uninstall-agent-hooks
                            remove Rocky Claude Code hooks; Codex config stays untouched.
  rocky setup --status       report host/MCP registration via rocky setup --check and
                            agent-hook state/capability; spool and Ollama/model health
                            are not checked.
  rocky check [--pre-push|--install-hook|--offline|--quiet]
                            hull check before push.
  rocky hook install        put Rocky's ears in your bash. every command heard,
                            failures remembered, dangerous commands questioned.
  rocky hook uninstall      remove the ears. memory stays.
  rocky hook status         are the ears in, question
  rocky hook agent-event claude-code|codex
                            private fail-open agent hook endpoint; stdout is always {}.

memory lives in ~/.rocky/memory.jsonl. no telemetry. only outside call is rocky
check asking registry.npmjs.org whether package exists — package name only, you say
yes first, offline never blocks. configured hosts control what they forward;
optional AI uses loopback Ollama only.
`;

type HookRequest =
  | { kind: "install" | "uninstall" | "status" }
  | { kind: "agent-event"; adapter: "claude-code" | "codex"; argvPayload?: string };

function parseHookArgs(argv: readonly string[]): HookRequest {
  const [subcommand, ...rest] = argv;
  if (subcommand === "install" || subcommand === "uninstall" || subcommand === "status") {
    if (rest.length !== 0) {
      throw new CliUsageError(`unexpected argument: ${rest[0]}`, "rocky hook install|uninstall|status");
    }
    return { kind: subcommand };
  }
  if (subcommand === "agent-event") {
    const [adapter, payload] = rest;
    if (adapter === "claude-code" && rest.length === 1) {
      return { kind: "agent-event", adapter };
    }
    if (adapter === "codex" && (rest.length === 1 || rest.length === 2)) {
      return payload === undefined
        ? { kind: "agent-event", adapter }
        : { kind: "agent-event", adapter, argvPayload: payload };
    }
  }
  throw new CliUsageError("hook needs one known subcommand", "rocky hook install|uninstall|status|agent-event claude-code|codex");
}

async function main(): Promise<number> {
  const [, , command, ...rest] = process.argv;
  try {
    switch (command) {
      case "run":
        return run(parseExactCommand(rest, "rocky run <command>"));
      case "watch":
        return watch(rest);
      case "recall":
        return recall(rest);
      case "model":
        return model(rest);
      case "stats":
        return stats(rest);
      case "mcp":
        return mcp(rest);
      case "setup":
        return setup(rest);
      case "check":
        return check(rest);
      case "what":
        return what(rest);
      case "how":
        return how(rest);
      case "why":
        return why(rest);
      case "digest":
        return digest(rest);
      case "quiz":
        return quiz(rest);
      case "export":
        return exportCommand(rest);
      case "hook": {
        const parsed = parseHookArgs(rest);
        switch (rest[0]) {
          case "install":
            return hookInstall();
          case "uninstall":
            return hookUninstall();
          case "status":
            return hookStatus();
          case "agent-event":
            if (parsed.kind === "agent-event") {
              return agentEvent(parsed.adapter, parsed.argvPayload === undefined ? undefined : { argvPayload: parsed.argvPayload });
            }
            break;
        }
        throw new Error("unreachable hook request");
      }
      case "_hookfail":
        return hookFail(rest[0] ?? "", Number(rest[1] ?? 1), rest[2] ?? process.cwd());
      case "_hooksuccess":
        return hookSuccess(rest[0] ?? "", rest[1] ?? process.cwd());
      case "_annotate":
        return annotateCommand(rest[0] ?? "");
      case "_ambiguity":
        return ambiguityCommand(rest[0] ?? "");
      case "--version":
        if (rest.length !== 0) throw new CliUsageError(`unexpected argument: ${rest[0]}`, "rocky --version");
        console.log(PACKAGE_VERSION);
        return 0;
      case "--help":
      case "-h":
      case "help":
      case undefined:
        if (rest.length !== 0) throw new CliUsageError(`unexpected argument: ${rest[0]}`, "rocky --help");
        console.log(face());
        console.log(HELP);
        return 0;
      default:
        say(`"${command}" is not command I know. run --help, question`);
        return 2;
    }
  } catch (error) {
    const code = reportCliUsage(error, say, detail);
    if (code !== undefined) return code;
    throw error;
  }
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => {
    say(`something break inside me. bad bad bad. ${String(error)}`);
    process.exitCode = 1;
  },
);
