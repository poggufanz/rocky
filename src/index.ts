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
import { briefCommand } from "./commands/brief.js";
import { watch } from "./commands/watch.js";
import { recall } from "./commands/recall.js";
import { model } from "./commands/model.js";
import { stats } from "./commands/stats.js";
import { hookFail, hookInstall, hookStatus, hookSuccess, hookUninstall } from "./commands/hook.js";
import { mcp } from "./commands/mcp.js";
import { setup } from "./commands/setup.js";
import { check } from "./commands/check.js";
import { digest, exportCommand, how, quiz, what, why } from "./commands/dictionary.js";
import { conceptsCommand } from "./commands/concepts.js";
import { agentEvent } from "./commands/agent-hook.js";
import { gateEvent } from "./agent/gate.js";
import { journalCommand } from "./commands/journal.js";
import { invariantsCommand } from "./commands/invariants.js";
import { sessionsCommand } from "./commands/sessions.js";
import { replCommand } from "./commands/repl.js";
import { annotateCommand } from "./agent/annotate.js";
import { ambiguityCommand } from "./agent/ambiguity.js";
import { CliUsageError, parseExactCommand, reportCliUsage } from "./commands/cli-args.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./core/package-info.js";
import { detail, face, flushHookSpeech, say } from "./ui/rocky.js";

const HELP = `
rocky — he remembers, so you don't have to.

install:
  npm install -g ${PACKAGE_NAME}
  version: ${PACKAGE_NAME}@${PACKAGE_VERSION}

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
  rocky brief [--since <ref|24h>] [--quiet] [--ai]
                            hear what changed since last brief: commits by
                            area, remembered failures and fixes, touched
                            invariant guards, questions reviewer may ask.
                            --ai polishes wording via loopback Ollama only.
  rocky recall [--] <query...>
                            ask Rocky's memory. matches words from error or command.
  rocky recall --ai [--] <query...>
                            --ai asks configured local Ollama after deterministic recall.
  rocky what [--ai] [--] <query...>
                            look up what remembered intent became.
  rocky how [--diff] [--] <query...>
                            remember how intent became code.
  rocky why [--diff] [--add "<text>"] [--] <file>
                            hear why remembered change touched file.
  rocky digest              hear this week's remembered intent pattern.
  rocky quiz                practice newest remembered intent or note; asks, then reveals,
                            deterministic newest-first, stable id tie-break, repeats unchanged
                            candidates, and never grades.
  rocky export [--kind failure|fix|note|triple] [--since ISO|Nd]
                            dump raw memory as JSONL on stdout.
  rocky concepts            list concepts heard in memory, with counts and aliases.
  rocky concept <id>        hear newest-first evidence for one concept.
  rocky concept alias [--retract] "<phrase>" <id>
                            teach or retract one phrase -> concept alias.
  rocky model status         report local-AI configuration without loading a model.
  rocky model use [--exposure sanitized|raw] <installed-model>
                            probe an installed Ollama model, then enable local AI.
  rocky model off            disable Rocky local AI. Ollama stays untouched.
  rocky stats               what Rocky holds in memory.
  rocky journal "<note>"    write one line dogfood note. local file only.
  rocky invariants          list remembered invariant notes from .rocky/invariants.md
                            and hear globs that guard nothing.
  rocky sessions [--limit <n>]
                            list work sessions derived from memory: grouped by cwd,
                            split on a 30-minute gap. derived at read time only,
                            newest-first.
  rocky sessions <index>    hear one session's evidence, chronologically.
  rocky repl [--ai]         stay in one loop over recall/what/why/how/concepts/
                            sessions instead of paying startup per call.
                            --ai passes through to recall and what. type help
                            inside for command list, quit or exit to leave.
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
                            installs the PreToolUse rationale gate too, unless you pass
                            --no-rationale-gate. Codex has no deny hook; notify lane only.
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
  rocky hook agent-event generic --rationale "<text>" [--files a.ts,b.ts]
                            any agent says why here, one line. no vendor log needed.
  rocky hook gate-event claude-code
                            PreToolUse enforcement endpoint; reads one hook payload from
                            stdin, prints an allow/deny decision, always exits 0.

memory lives in ~/.rocky/memory.jsonl. no telemetry. only outside call is rocky
check asking registry.npmjs.org whether package exists — package name only, you say
yes first, offline never blocks. configured hosts control what they forward;
optional AI uses loopback Ollama only.
`;

type HookRequest =
  | { kind: "install" | "uninstall" | "status" }
  | {
    kind: "agent-event";
    adapter: "claude-code" | "codex" | "generic";
    argvPayload?: string;
    rationale?: string;
    files?: string[];
  }
  | { kind: "gate-event"; vendor: string };

interface NotifyFlags {
  rationale?: string;
  files?: string[];
  /** Everything left after `--rationale`/`--files` are consumed. */
  positionals: string[];
}

function isFlagToken(value: string | undefined): boolean {
  return typeof value === "string" && value.startsWith("--");
}

/**
 * Pull `--rationale <text>` and `--files a,b` out of one `agent-event`
 * invocation's trailing args, in any order, leaving everything else as
 * positionals (codex's optional payload). A flag with a missing or
 * flag-shaped value is dropped, not thrown — this endpoint stays fail-open
 * end to end, including at argument parsing.
 */
function parseNotifyFlags(args: readonly string[]): NotifyFlags {
  const positionals: string[] = [];
  let rationale: string | undefined;
  let files: string[] | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--rationale") {
      const value = args[i + 1];
      if (typeof value === "string" && !isFlagToken(value)) {
        rationale = value;
        i += 1;
      }
      continue;
    }
    if (arg === "--files") {
      const value = args[i + 1];
      if (typeof value === "string" && !isFlagToken(value)) {
        const list = value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
        if (list.length > 0) files = list;
        i += 1;
      }
      continue;
    }
    positionals.push(arg);
  }
  return { ...(rationale === undefined ? {} : { rationale }), ...(files === undefined ? {} : { files }), positionals };
}

function parseHookArgs(argv: readonly string[]): HookRequest {
  const [subcommand, ...rest] = argv;
  if (subcommand === "install" || subcommand === "uninstall" || subcommand === "status") {
    if (rest.length !== 0) {
      throw new CliUsageError(`unexpected argument: ${rest[0]}`, "rocky hook install|uninstall|status");
    }
    return { kind: subcommand };
  }
  if (subcommand === "agent-event") {
    const [adapter, ...flagArgs] = rest;
    if (adapter === "generic" || adapter === "claude-code") {
      const { rationale, files, positionals } = parseNotifyFlags(flagArgs);
      if (positionals.length === 0) {
        return { kind: "agent-event", adapter, ...(rationale === undefined ? {} : { rationale }), ...(files === undefined ? {} : { files }) };
      }
    }
    if (adapter === "codex") {
      const { rationale, files, positionals } = parseNotifyFlags(flagArgs);
      if (positionals.length === 0 || positionals.length === 1) {
        return {
          kind: "agent-event",
          adapter,
          ...(positionals.length === 1 ? { argvPayload: positionals[0] } : {}),
          ...(rationale === undefined ? {} : { rationale }),
          ...(files === undefined ? {} : { files }),
        };
      }
    }
  }
  if (subcommand === "gate-event") {
    const [vendor, ...extra] = rest;
    if (typeof vendor === "string" && vendor.length > 0 && extra.length === 0) {
      return { kind: "gate-event", vendor };
    }
  }
  throw new CliUsageError(
    "hook needs one known subcommand",
    "rocky hook install|uninstall|status|agent-event claude-code|codex|generic|gate-event <vendor>",
  );
}

const GATE_STDIN_CAP_BYTES = 2 * 1024 * 1024;

/**
 * Read all of stdin for `gate-event`, bounded. A truncated or unreadable
 * payload is not fatal here — `gateEvent` parses tolerant JSON and fails
 * open on anything it cannot understand, so this reader only needs to
 * avoid unbounded memory growth, not validate the payload.
 */
async function readGateEventStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of process.stdin) {
      const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      total += buffer.byteLength;
      if (total > GATE_STDIN_CAP_BYTES) break;
      chunks.push(buffer);
    }
  } catch {
    // A stdin stream error still must not throw out of the gate.
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** `rocky hook gate-event <vendor>`: read stdin, decide, print, always exit 0. */
async function runGateEvent(vendor: string): Promise<number> {
  const stdin = await readGateEventStdin();
  const { stdout } = gateEvent(vendor, stdin);
  try {
    process.stdout.write(stdout);
  } catch {
    // Never fail the hook because stdout could not be written.
  }
  return 0;
}

async function main(): Promise<number> {
  const [, , command, ...rest] = process.argv;
  try {
    switch (command) {
      case "run":
        return run(parseExactCommand(rest, "rocky run <command>"));
      case "brief":
        return briefCommand(rest);
      case "watch":
        return watch(rest);
      case "recall":
        return recall(rest);
      case "model":
        return model(rest);
      case "stats":
        return stats(rest);
      case "journal":
        return journalCommand(rest);
      case "invariants":
        return invariantsCommand(rest);
      case "sessions":
        return sessionsCommand(rest);
      case "repl":
        return replCommand(rest);
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
      case "concepts":
      case "concept":
        return conceptsCommand(rest);
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
              return agentEvent(parsed.adapter, {
                ...(parsed.argvPayload === undefined ? {} : { argvPayload: parsed.argvPayload }),
                ...(parsed.rationale === undefined ? {} : { rationale: parsed.rationale }),
                ...(parsed.files === undefined ? {} : { files: parsed.files }),
              });
            }
            break;
          case "gate-event":
            if (parsed.kind === "gate-event") {
              return runGateEvent(parsed.vendor);
            }
            break;
        }
        throw new Error("unreachable hook request");
      }
      case "_hookfail":
        // F2 (task-a-brief): flush whatever sayTty/detailTty buffered
        // (ui/rocky.ts) exactly once, regardless of which internal branch
        // hookFail took or whether it threw — a dropped message is
        // acceptable, a message that never gets published because a return
        // site was missed is not.
        try {
          return hookFail(rest[0] ?? "", Number(rest[1] ?? 1), rest[2] ?? process.cwd());
        } finally {
          flushHookSpeech();
        }
      case "_hooksuccess":
        try {
          return hookSuccess(rest[0] ?? "", rest[1] ?? process.cwd());
        } finally {
          flushHookSpeech();
        }
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
