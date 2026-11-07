#!/usr/bin/env node
/**
 * rocky — a local CLI that remembers failed commands and what fixed them.
 *
 * Public surface:
 *   rocky run "<command>"     run a command; rocky remembers its failures and what followed
 *   rocky recall [--ai] <query> search the memory of past errors
 *   rocky | rocky dash        open the local GUI on 127.0.0.1
 *   rocky hook|mcp|model|setup distribution bridge commands
 *   rocky watch|check|what|how|why|digest|quiz|export v0.3–v0.5 surfaces
 *   rocky --help [--all]      short grouped view; --all prints every flag and endpoint
 *   rocky --version
 */

// Only these load at startup. Every command module loads on dispatch, through
// `await import()` inside its `case`, so `rocky --version`, each shell-hook
// spawn and each agent-hook call do not parse the whole command graph first.
// cli-startup-boundary.test.ts walks the static import closure and keeps it so.
import { CliUsageError, parseExactCommand, reportCliUsage } from "./commands/cli-args.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./core/package-info.js";
import { detail, flushHookSpeech, say } from "./ui/rocky.js";

/**
 * `rocky --help`: one screen, grouped by what you do. The
 * `version:` line stays because the release check reads it from this output;
 * the network facts stay because a short help must not hide what leaves the
 * machine. `HELP` below is the full reference, behind `rocky --help --all`.
 * documentation.test.ts holds the line and column budget of this text.
 */
const HELP_SHORT = `rocky — a local CLI that remembers failed commands and what fixed them.
version: ${PACKAGE_NAME}@${PACKAGE_VERSION}
usage: rocky <verb> [args]
  core    run | watch | recall | stats | dash
  review  check | brief | what | how | why | teach
  memory  digest | quiz | export | concepts | sessions | invariants |
          journal | repl
  setup   hook install|uninstall|status | setup | mcp | model
There is no telemetry. A registry lookup (rocky check) sends package names
only, to registry.npmjs.org, and only with your consent. The GUI fetches its
model list from models.dev. GUI chat code questions go to your BYOK model.
every flag, every endpoint: rocky --help --all`;

const HELP = `
rocky — a local CLI that remembers failed commands and what fixed them.

install:
  npm install -g ${PACKAGE_NAME}
  version: ${PACKAGE_NAME}@${PACKAGE_VERSION}

usage:
  rocky run "<command>"     run a command through rocky. Failures are remembered;
                            when the same error returns, rocky shows what worked
                            after it last time. It does not claim what changed.
                            On Windows, cmd.exe runs the command.
  rocky watch "<command>" [--quiet]
                            run a long command and wait for it. Failures are
                            remembered the same way as with run, the stderr tail
                            is saved on failure, and a desktop notification (or a
                            terminal bell) signals that it finished. --quiet
                            prints plain facts on stderr only and sends no
                            notification.
  rocky brief [--since <ref|24h>] [--quiet] [--ai] [--decompose]
                            summarize what changed since the last brief: commits
                            by area, remembered failures and fixes, touched
                            invariant guards, and questions a reviewer may ask.
                            --ai polishes the wording via loopback Ollama only.
                            --decompose appends a behavior, fields, and verify
                            checklist.
  rocky recall [--] <query...>
                            search remembered failures. Matches words from the
                            error or the command.
  rocky recall --ai [--] <query...>
                            --ai asks the configured local Ollama after the
                            deterministic recall.
  rocky what [--ai] [--] <query...>
                            look up what a remembered intent became.
  rocky how [--diff] [--] <query...>
                            show how a remembered intent became code.
  rocky why [--diff] [--] <file>
                            show why a remembered change touched the file.
  rocky why --add "<text>" [--files a.ts,b.ts]
                            record your own reason. --files names the files it
                            explains. Without --files, it attaches to the newest
                            failure or fix recorded in this directory.
  rocky teach <file>[:<line>] [--ladder]
                            explain why this code exists, from a witness record
                            or local evidence.
  rocky digest              show this week's pattern of remembered intent.
  rocky quiz                practice newest remembered intent or note; asks, then reveals,
                            deterministic newest-first, repeats unchanged candidates, and
                            never grades.
  rocky export [--kind failure|fix|note|triple] [--since ISO|Nd]
                            dump raw memory as JSONL on stdout. triple = intent.
  rocky concepts            list the concepts in memory, with counts and aliases.
  rocky concept <id>        show the newest-first evidence for one concept.
  rocky concept alias [--retract] "<phrase>" <id>
                            add or retract one phrase -> concept alias.
  rocky model status        report the local-AI configuration without loading a model.
  rocky model use [--exposure sanitized|raw] <installed-model>
                            probe an installed Ollama model, then enable local AI.
  rocky model off           disable local AI in rocky. Ollama stays untouched.
  rocky | rocky dash        open the local GUI in a browser. One link, one route;
                            dash just starts on the Dash segment. Loopback only,
                            with a fresh token each launch. --no-open prints the
                            URL instead, --port=<n> picks the port, and ctrl-c
                            stops the server.
  rocky stats [--cycles]    show what rocky holds in memory. --cycles lists the
                            top failure fingerprints with counts, local only.
  rocky journal "<note>"    write one dogfood note as a single line. Local file only.
  rocky invariants          list remembered invariant notes from .rocky/invariants.md
                            and report globs that guard nothing.
  rocky sessions [--limit <n>]
                            list work sessions derived from memory: grouped by cwd,
                            split on a 30-minute gap. Derived at read time only,
                            newest-first.
  rocky sessions <index>    show one session's evidence in chronological order.
  rocky repl [--ai]         stay in one loop over recall/what/why/how/concepts/
                            sessions instead of paying startup per call.
                            --ai passes through to recall and what. Type help
                            inside for the command list, quit or exit to leave.
  rocky mcp                 serve read-only memory tools over stdio.
  rocky setup               configure detected MCP hosts with sanitized exposure.
  rocky setup --check       verify owned host registrations and the rocky MCP tools.
  rocky setup --remove      remove owned rocky registrations from detected hosts,
                            and move a managed voice skill that an older release
                            installed into a backup folder.
  rocky setup --replace     replace conflicting registrations after confirmation.
  rocky setup --harness     open a checkbox picker (Up/Down, Space, Enter) for hosts.
  rocky setup --harness <id> [--harness <id>] [--yes]
                            configure only the named hosts: claude-code, codex,
                            opencode, gemini-cli, and copilot-cli have MCP adapters.
  rocky setup --mcp-exposure sanitized|raw
                            choose the projected-memory exposure during configure.
  rocky setup --agent-hooks
                            install Claude Code hooks after explicit consent and
                            print the Codex TOML. This installs the PreToolUse
                            rationale gate too, unless you pass --no-rationale-gate.
                            Codex has no deny hook; it uses the notify lane only.
  rocky setup --uninstall-agent-hooks
                            remove rocky's Claude Code hooks; Codex config stays untouched.
  rocky setup --status      report host/MCP registration via rocky setup --check and
                            agent-hook state/capability; spool and Ollama/model health
                            are not checked.
  rocky setup --repo <path> --allow-capture|--revoke-capture|--check-capture|--purge-capture
                            listening consent for one git repo. The disk budget is
                            160 MiB per repo, with the oldest data pruned first.
                            check shows the disk held. purge revokes capture and
                            deletes history, with no undo.
  rocky check [--pre-push|--install-hook|--offline|--quiet]
                            run the hull check before a push.
  rocky check --prompt "<text>" [--stdin] [--quiet]
                            score prompt clarity locally, with no model. Always
                            exits 0.
  rocky check --decompose [--quiet]
                            split the staged change into behavior, fields, and
                            verify. Local only; always exits 0.
  rocky hook install        install the rocky shell hook for bash and PowerShell.
                            Every command's result is checked and failures are
                            remembered. The bash hook asks before dangerous
                            commands.
  rocky hook uninstall      remove the shell hook. Memory stays.
  rocky hook status         report whether the shell hook is installed.
  rocky hook agent-event claude-code|codex
                            private fail-open agent hook endpoint; stdout is always {}.
  rocky hook agent-event generic --rationale "<text>" [--files a.ts,b.ts]
                            any agent can record why here, in one line. No vendor
                            log needed.
  rocky hook listen-event <harnessId> --surface <cli|ide|local>
                            one-shot native event ingress; static argv, stdin
                            JSON only, fail-open, stdout stays empty.
  rocky hook gate-event claude-code
                            PreToolUse enforcement endpoint; reads one hook payload from
                            stdin, prints an allow/deny decision, always exits 0.

Memory lives in ~/.rocky/memory.jsonl. There is no telemetry. Outside calls:
rocky check asks registry.npmjs.org whether a package exists (package name only,
after you say yes first; offline never blocks), and the GUI model picker asks
models.dev for the model list. GUI Main chat code questions send the question,
carved excerpts, and memory evidence to the model you configure, only when you
set one; a memory-only question sends nothing. Configured hosts control what they
forward; optional AI uses loopback Ollama only.
ROCKY_VERBOSE=1 shows internal counters and record ids; default output hides them.
`;

type HelpView = "short" | "full";

/**
 * `rocky --help [--all]`. Only a leading `--all` asks for the full reference.
 * The token reported as unexpected is the first one that is not that leading
 * `--all`, so `--help --all junk` blames `junk` and never the `--all`.
 */
function parseHelpArgs(args: readonly string[]): HelpView {
  const full = args[0] === "--all";
  const unexpected = args[full ? 1 : 0];
  if (unexpected !== undefined) throw new CliUsageError(`unexpected argument: ${unexpected}`, "rocky --help [--all]");
  return full ? "full" : "short";
}

/** The short grouped view or the full reference, on stdout. */
function printHelp(view: HelpView): number {
  console.log(view === "full" ? HELP : HELP_SHORT);
  return 0;
}

type HookRequest =
  | { kind: "install" | "uninstall" | "status" }
  | {
    kind: "agent-event";
    adapter: "claude-code" | "codex" | "generic";
    argvPayload?: string;
    rationale?: string;
    explainCode?: string;
    explainBusiness?: string;
    files?: string[];
  }
  | { kind: "gate-event"; vendor: string }
  | { kind: "listen-event"; harnessId: string; surface: string };

interface NotifyFlags {
  rationale?: string;
  explainCode?: string;
  explainBusiness?: string;
  files?: string[];
  /** Everything left after `--rationale`/`--explain-*`/`--files` are consumed. */
  positionals: string[];
}

function isFlagToken(value: string | undefined): boolean {
  return typeof value === "string" && value.startsWith("--");
}

/**
 * Pull `--rationale <text>`, `--explain-code <text>`, `--explain-business <text>`
 * and `--files a,b` out of one `agent-event` invocation's trailing args, in
 * any order, leaving everything else as positionals (codex's optional payload).
 * A flag with a missing or flag-shaped value is dropped, not thrown — this
 * endpoint stays fail-open end to end, including at argument parsing.
 */
function parseNotifyFlags(args: readonly string[]): NotifyFlags {
  const positionals: string[] = [];
  let rationale: string | undefined;
  let explainCode: string | undefined;
  let explainBusiness: string | undefined;
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
    if (arg === "--explain-code") {
      const value = args[i + 1];
      if (typeof value === "string" && !isFlagToken(value)) {
        explainCode = value;
        i += 1;
      }
      continue;
    }
    if (arg === "--explain-business") {
      const value = args[i + 1];
      if (typeof value === "string" && !isFlagToken(value)) {
        explainBusiness = value;
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
  return {
    ...(rationale === undefined ? {} : { rationale }),
    ...(explainCode === undefined ? {} : { explainCode }),
    ...(explainBusiness === undefined ? {} : { explainBusiness }),
    ...(files === undefined ? {} : { files }),
    positionals,
  };
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
      const { rationale, explainCode, explainBusiness, files, positionals } = parseNotifyFlags(flagArgs);
      if (positionals.length === 0) {
        return {
          kind: "agent-event",
          adapter,
          ...(rationale === undefined ? {} : { rationale }),
          ...(explainCode === undefined ? {} : { explainCode }),
          ...(explainBusiness === undefined ? {} : { explainBusiness }),
          ...(files === undefined ? {} : { files }),
        };
      }
    }
    if (adapter === "codex") {
      const { rationale, explainCode, explainBusiness, files, positionals } = parseNotifyFlags(flagArgs);
      if (positionals.length === 0 || positionals.length === 1) {
        return {
          kind: "agent-event",
          adapter,
          ...(positionals.length === 1 ? { argvPayload: positionals[0] } : {}),
          ...(rationale === undefined ? {} : { rationale }),
          ...(explainCode === undefined ? {} : { explainCode }),
          ...(explainBusiness === undefined ? {} : { explainBusiness }),
          ...(files === undefined ? {} : { files }),
        };
      }
    }
  }
  if (subcommand === "listen-event") {
    const harnessId = rest[0];
    if (typeof harnessId === "string" && harnessId.length > 0
      && rest[1] === "--surface" && typeof rest[2] === "string" && rest[2].length > 0 && rest.length === 3) {
      return { kind: "listen-event", harnessId, surface: rest[2] };
    }
    throw new CliUsageError(
      "hook listen-event needs one harness id and one surface",
      "rocky hook listen-event <harnessId> --surface <cli|ide|local|profile>",
    );
  }
  if (subcommand === "gate-event") {
    const [vendor, ...extra] = rest;
    if (typeof vendor === "string" && vendor.length > 0 && extra.length === 0) {
      return { kind: "gate-event", vendor };
    }
  }
  throw new CliUsageError(
    "hook needs one known subcommand",
    "rocky hook install|uninstall|status|agent-event claude-code|codex|generic|gate-event <vendor>|listen-event <harnessId> --surface <surface>",
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

/** Bounded stdin read for one-shot hook lanes. Never throws. */
async function readHookStdin(capBytes: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of process.stdin) {
      const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      total += buffer.byteLength;
      if (total > capBytes) break;
      chunks.push(buffer);
    }
  } catch {
    // A stdin stream error still must not throw out of the hook.
  }
  return Buffer.concat(chunks);
}

/** Host-consent probe for the listen lane: explicit opt-in only, never PATH/config guessing. */
function listenHostConsent(): boolean {
  const raw = process.env.ROCKY_LISTEN_HOSTS ?? "";
  return raw.split(",").some((entry) => entry.trim().length > 0);
}

/** `rocky hook listen-event <harnessId> --surface <surface>`: static argv, stdin JSON, fail-open, empty stdout. */
async function runListenEvent(harnessId: string, surface: string): Promise<number> {
  let stdinBytes: Uint8Array;
  try {
    stdinBytes = await readHookStdin(64 * 1024);
  } catch {
    return 0;
  }
  try {
    const ingress = await import("./listening/hook-ingress.js");
    const result = await ingress.handleListenEvent(
      ["listen-event", harnessId, "--surface", surface],
      stdinBytes,
      { hostConsent: listenHostConsent() },
    );
    void result;
  } catch {
    // Fail open: host work never breaks on capture trouble. Stdout stays empty.
  }
  return 0;
}

/** `rocky hook gate-event <vendor>`: read stdin, decide, print, always exit 0. */
async function runGateEvent(vendor: string): Promise<number> {
  const stdin = await readGateEventStdin();
  let stdout = "{}"; // the hook's allow decision
  try {
    const { gateEvent } = await import("./agent/gate.js");
    stdout = gateEvent(vendor, stdin).stdout;
  } catch {
    // `gateEvent` never throws, but the module can fail to load. The gate must
    // never block work by breaking, so a load failure allows.
  }
  try {
    process.stdout.write(stdout);
  } catch {
    // Never fail the hook because stdout could not be written.
  }
  return 0;
}

async function main(): Promise<number> {
  const [, , command, ...rest] = process.argv;
  if (command === undefined || command === "--no-open" || command?.startsWith("--port=")) {
    const flags = command === undefined ? [] : [command, ...rest];
    // A browser needs a human at the keyboard, so a pipe falls through to the
    // short help, except under --no-open: that serves the page and prints the
    // URL, so no terminal is needed.
    const { guiWanted, guiCommand } = await import("./commands/gui.js");
    if (guiWanted(flags, process.stdout.isTTY === true, process.stdin.isTTY === true)) {
      return guiCommand(flags, "main");
    }
    if (command?.startsWith("--port=")) return printHelp("short");
  }
  try {
    switch (command) {
      case "run": {
        const cmd = parseExactCommand(rest, "rocky run <command>");
        return (await import("./commands/run.js")).run(cmd);
      }
      case "dash":
        return (await import("./commands/dash.js")).dashCommand(rest);
      case "brief":
        return (await import("./commands/brief.js")).briefCommand(rest);
      case "watch":
        return (await import("./commands/watch.js")).watch(rest);
      case "recall":
        return (await import("./commands/recall.js")).recall(rest);
      case "model":
        return (await import("./commands/model.js")).model(rest);
      case "stats":
        return (await import("./commands/stats.js")).stats(rest);
      case "journal":
        return (await import("./commands/journal.js")).journalCommand(rest);
      case "invariants":
        return (await import("./commands/invariants.js")).invariantsCommand(rest);
      case "sessions":
        return (await import("./commands/sessions.js")).sessionsCommand(rest);
      case "repl":
        return (await import("./commands/repl.js")).replCommand(rest);
      case "mcp":
        return (await import("./commands/mcp.js")).mcp(rest);
      case "setup":
        return (await import("./commands/setup.js")).setup(rest);
      case "check":
        return (await import("./commands/check.js")).check(rest);
      case "what":
        return (await import("./commands/dictionary.js")).what(rest);
      case "how":
        return (await import("./commands/dictionary.js")).how(rest);
      case "why":
        return (await import("./commands/dictionary.js")).why(rest);
      case "teach":
        return (await import("./commands/teach.js")).teach(rest);
      case "digest":
        return (await import("./commands/dictionary.js")).digest(rest);
      case "quiz":
        return (await import("./commands/dictionary.js")).quiz(rest);
      case "export":
        return (await import("./commands/dictionary.js")).exportCommand(rest);
      case "concepts":
      case "concept":
        return (await import("./commands/concepts.js")).conceptsCommand(rest);
      case "hook": {
        const parsed = parseHookArgs(rest);
        switch (rest[0]) {
          case "install":
            return (await import("./commands/hook.js")).hookInstall();
          case "uninstall":
            return (await import("./commands/hook.js")).hookUninstall();
          case "status":
            return (await import("./commands/hook.js")).hookStatus();
          case "agent-event":
            if (parsed.kind === "agent-event") {
              const { agentEvent } = await import("./commands/agent-hook.js");
              return agentEvent(parsed.adapter, {
                ...(parsed.argvPayload === undefined ? {} : { argvPayload: parsed.argvPayload }),
                ...(parsed.rationale === undefined ? {} : { rationale: parsed.rationale }),
                ...(parsed.explainCode === undefined ? {} : { explainCode: parsed.explainCode }),
                ...(parsed.explainBusiness === undefined ? {} : { explainBusiness: parsed.explainBusiness }),
                ...(parsed.files === undefined ? {} : { files: parsed.files }),
              });
            }
            break;
          case "gate-event":
            if (parsed.kind === "gate-event") {
              return runGateEvent(parsed.vendor);
            }
            break;
          case "listen-event":
            if (parsed.kind === "listen-event") {
              return runListenEvent(parsed.harnessId, parsed.surface);
            }
            break;
        }
        throw new Error("unreachable hook request");
      }
      case "_hookfail":
        // Flush whatever sayTty/detailTty buffered
        // (ui/rocky.ts) exactly once, regardless of which internal branch
        // hookFail took or whether it threw — a dropped message is
        // acceptable, a message that never gets published because a return
        // site was missed is not.
        try {
          const { hookFail } = await import("./commands/hook.js");
          return hookFail(rest[0] ?? "", Number(rest[1] ?? 1), rest[2] ?? process.cwd());
        } finally {
          flushHookSpeech();
        }
      case "_hooksuccess":
        try {
          const { hookSuccess } = await import("./commands/hook.js");
          return hookSuccess(rest[0] ?? "", rest[1] ?? process.cwd());
        } finally {
          flushHookSpeech();
        }
      case "_annotate":
        return (await import("./agent/annotate.js")).annotateCommand(rest[0] ?? "");
      case "_ambiguity":
        return (await import("./agent/ambiguity.js")).ambiguityCommand(rest[0] ?? "");
      case "--version":
        if (rest.length !== 0) throw new CliUsageError(`unexpected argument: ${rest[0]}`, "rocky --version");
        console.log(PACKAGE_VERSION);
        return 0;
      case "--help":
      case "-h":
      case "help":
      case undefined:
        return printHelp(parseHelpArgs(rest));
      default:
        say(`Unknown command "${command}". Run rocky --help to list commands.`);
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
    say(`Unexpected internal error: ${String(error)}`);
    process.exitCode = 1;
  },
);
