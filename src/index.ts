#!/usr/bin/env node
/**
 * rocky — a blind Eridian engineer who lives in your terminal.
 *
 * Public surface:
 *   rocky run "<command>"     run a command; Rocky remembers failures & fixes
 *   rocky recall [--ai] <query> search Rocky's memory of past errors
 *   rocky hook|mcp|model|setup distribution bridge commands
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
import { how, what, why } from "./commands/dictionary.js";
import { agentEvent } from "./commands/agent-hook.js";
import { annotateCommand } from "./agent/annotate.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./core/package-info.js";
import { face, say } from "./ui/rocky.js";

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
  rocky what <query...>     look up what remembered intent became.
  rocky how <query...>      remember how intent became code.
  rocky why <file>          hear why remembered change touched file.
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
  rocky setup --status       report Claude Code agent-hook state; Codex remains manual.
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

async function main(): Promise<number> {
  const [, , command, ...rest] = process.argv;
  const arg = rest.join(" ");

  switch (command) {
    case "run":
      return run(arg);
    case "watch":
      return watch(rest);
    case "recall":
      return recall(rest);
    case "model":
      return model(rest);
    case "stats":
      return stats();
    case "mcp":
      return mcp();
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
    case "hook":
      switch (rest[0]) {
        case "install":
          return hookInstall();
        case "uninstall":
          return hookUninstall();
        case "status":
          return hookStatus();
        case "agent-event":
          return agentEvent(rest[1] ?? "", rest[1] === "codex" ? { argvPayload: rest[2] } : undefined);
        default:
          say("hook needs install, uninstall, or status. which one, question");
          return 2;
      }
    case "_hookfail":
      return hookFail(rest[0] ?? "", Number(rest[1] ?? 1), rest[2] ?? process.cwd());
    case "_hooksuccess":
      return hookSuccess(rest[0] ?? "", rest[1] ?? process.cwd());
    case "_annotate":
      return annotateCommand(rest[0] ?? "");
    case "--version":
      console.log(PACKAGE_VERSION);
      return 0;
    case "--help":
    case "-h":
    case "help":
    case undefined:
      console.log(face());
      console.log(HELP);
      return 0;
    default:
      say(`"${command}" is not command I know. run --help, question`);
      return 2;
  }
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => {
    say(`something break inside me. bad bad bad. ${String(error)}`);
    process.exitCode = 1;
  },
);
