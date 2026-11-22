import { existsSync } from "node:fs";
import type { AttemptNote } from "../core/attempt-note.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import { parseToolResultPayload, TOOL_RESULT_STDIN_CAP_BYTES } from "../core/tool-result.js";

export { TOOL_RESULT_STDIN_CAP_BYTES };

export const TOOL_RESULT_LOCK_WAIT_MS = 1_000;

const EMPTY_RESPONSE = "{}";
const MAX_HOOK_STDOUT_BYTES = 2 * 1024;
const DECODER = new TextDecoder("utf-8");

type AttemptNoteStateModule = typeof import("../core/attempt-note-state.js");

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function isLockBusyError(error: unknown): boolean {
  return error instanceof Error && /triple lock is busy/u.test(error.message);
}

function readSkipContext(stdin: Uint8Array): { isFailureEvent: boolean; session: string | null; cwd: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(DECODER.decode(stdin));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    const isFailureEvent = record.hook_event_name === "PostToolUseFailure";
    const session = typeof record.session_id === "string" && record.session_id.length > 0 ? record.session_id : null;
    const cwd = typeof record.cwd === "string" ? record.cwd : "";
    return { isFailureEvent, session, cwd };
  } catch {
    return undefined;
  }
}

function appendSkipRow(
  stateMod: AttemptNoteStateModule,
  home: string,
  params: { ts: number; session: string | null; cwd: string; latencyMs: number; reason: string },
): void {
  stateMod.appendExposure(home, {
    v: 1,
    ts: params.ts,
    session: params.session,
    lane: "tool-result",
    kind: "skip",
    arm: null,
    key: null,
    cwdHash: stateMod.cwdHash(params.cwd),
    anchorFailureId: null,
    latencyMs: params.latencyMs,
    delivered: false,
    bytes: 0,
    reason: params.reason,
  });
}

function buildContextStdout(noteText: string): string {
  const candidate = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUseFailure",
      additionalContext: noteText,
    },
  });
  return Buffer.byteLength(candidate, "utf8") < MAX_HOOK_STDOUT_BYTES ? candidate : EMPTY_RESPONSE;
}

/**
 * Private Claude Code PostToolUse / PostToolUseFailure hook handler.
 * Records unwrapped Bash/PowerShell failures as agent-origin failures, links
 * fixes on pass when a pending marker exists, and returns a prior-attempts
 * additionalContext payload when eligible and delivered. Fail-open and never throws.
 */
export async function toolResultHook(stdin: Uint8Array, startedAt?: number): Promise<string> {
  const started = startedAt ?? performance.now();
  try {
    const event = parseToolResultPayload(stdin);
    if (event === undefined) return EMPTY_RESPONSE;

    if (event.kind === "pass") {
      if (!existsSync(resolveRockyPaths().pending)) return EMPTY_RESPONSE;
      const { resolveFixOnSuccess } = await import("../core/memory.js");
      resolveFixOnSuccess(event.cmd, event.cwd, {
        agent: event.agent,
        lockWaitMs: TOOL_RESULT_LOCK_WAIT_MS,
      });
      return EMPTY_RESPONSE;
    }

    if (event.kind === "skip") {
      if (process.env.ROCKY_ATTEMPT_ADVISORY === "off") return EMPTY_RESPONSE;
      const skipContext = readSkipContext(stdin);
      if (skipContext === undefined || !skipContext.isFailureEvent) return EMPTY_RESPONSE;
      const stateMod = await import("../core/attempt-note-state.js");
      if (stateMod.noteAdvisoryEnabled(process.env)) {
        appendSkipRow(stateMod, resolveRockyPaths().home, {
          ts: Date.now(),
          session: skipContext.session,
          cwd: skipContext.cwd,
          latencyMs: elapsedMs(started),
          reason: event.reason,
        });
      }
      return EMPTY_RESPONSE;
    }

    const home = resolveRockyPaths().home;
    const now = Date.now();
    const advisoryAllowed = process.env.ROCKY_ATTEMPT_ADVISORY !== "off";
    const { recordAgentFailure } = await import("../core/memory.js");
    let stateMod: AttemptNoteStateModule | undefined;
    if (advisoryAllowed) {
      try {
        stateMod = await import("../core/attempt-note-state.js");
      } catch {
        stateMod = undefined;
      }
    }
    const enabled = stateMod !== undefined && stateMod.noteAdvisoryEnabled(process.env);

    let noteDeps: {
      priorAttemptsNote: typeof import("../core/attempt-note.js").priorAttemptsNote;
      fingerprint: typeof import("../core/fingerprint.js").fingerprint;
      makeCardsFor: typeof import("../desk/cards-read.js").makeCardsFor;
      toolTextAllowed: typeof import("../desk/cards-read.js").toolTextAllowed;
    } | undefined;
    if (enabled) {
      try {
        const [noteMod, fpMod, cardsMod] = await Promise.all([
          import("../core/attempt-note.js"),
          import("../core/fingerprint.js"),
          import("../desk/cards-read.js"),
        ]);
        noteDeps = {
          priorAttemptsNote: noteMod.priorAttemptsNote,
          fingerprint: fpMod.fingerprint,
          makeCardsFor: cardsMod.makeCardsFor,
          toolTextAllowed: cardsMod.toolTextAllowed,
        };
      } catch {
        noteDeps = undefined;
      }
    }

    let result;
    try {
      result = recordAgentFailure<AttemptNote | undefined>(
        {
          cmd: event.cmd,
          exitCode: event.exitCode,
          body: event.body,
          cwd: event.cwd,
          agent: event.agent,
        },
        {
          lockWaitMs: TOOL_RESULT_LOCK_WAIT_MS,
          now,
          observe: ({ records, coverage }) => {
            if (noteDeps === undefined) return undefined;
            try {
              const cardsFor = noteDeps.makeCardsFor({
                home,
                toolText: noteDeps.toolTextAllowed(home),
              });
              return noteDeps.priorAttemptsNote(
                records,
                coverage,
                { fingerprints: [noteDeps.fingerprint(event.body, event.cmd, event.exitCode)], cwd: event.cwd },
                { now, cardsFor, platform: process.platform },
              );
            } catch {
              return undefined;
            }
          },
        },
      );
    } catch (error) {
      if (enabled && stateMod !== undefined && isLockBusyError(error)) {
        appendSkipRow(stateMod, home, {
          ts: now,
          session: event.agent.session ?? null,
          cwd: event.cwd,
          latencyMs: elapsedMs(started),
          reason: "lock_busy",
        });
      }
      return EMPTY_RESPONSE;
    }

    if (result.status === "skipped") {
      if (enabled && stateMod !== undefined) {
        appendSkipRow(stateMod, home, {
          ts: now,
          session: event.agent.session ?? null,
          cwd: event.cwd,
          latencyMs: elapsedMs(started),
          reason: result.reason,
        });
      }
      return EMPTY_RESPONSE;
    }

    const note = result.observed;
    if (!enabled || stateMod === undefined || note === undefined) {
      return EMPTY_RESPONSE;
    }

    const session = event.agent.session;
    const arm = stateMod.attemptArm(session, process.env);
    const wouldShow = arm === "shown" || arm === "human";
    const claimed = wouldShow && stateMod.claimNoteSlot(home, session, note.key, now);
    const stdout = claimed ? buildContextStdout(note.text) : EMPTY_RESPONSE;
    const delivered = stdout !== EMPTY_RESPONSE;

    stateMod.appendExposure(home, {
      v: 1,
      ts: now,
      session: session ?? null,
      lane: "tool-result",
      kind: "note",
      arm,
      key: note.key,
      cwdHash: stateMod.cwdHash(event.cwd),
      anchorFailureId: result.record.id,
      latencyMs: elapsedMs(started),
      delivered,
      bytes: note.bytes,
    });

    return stdout;
  } catch {
    // Fail open: the tool-result hook must never block or fail the host.
  }
  return EMPTY_RESPONSE;
}
