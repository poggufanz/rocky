import { existsSync } from "node:fs";
import type { AttemptNote } from "../core/attempt-note.js";
import { refreshFixTouchAfterFix } from "../core/fixtouch-cache.js";
import type { MemoryCoverage, MemoryRecord } from "../core/memory-read.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import { TOOL_RESULT_STDIN_CAP_BYTES } from "../core/tool-result.js";
import { loadHarnessDecoder } from "../harnesses/index.js";
import { projectToToolResult, renderSyncResponse } from "../harnesses/projections/to-tool-result.js";

export { TOOL_RESULT_STDIN_CAP_BYTES };

export const TOOL_RESULT_LOCK_WAIT_MS = 1_000;

const EMPTY_RESPONSE = "{}";
const DECODER = new TextDecoder("utf-8");

type AttemptNoteStateModule = typeof import("../core/attempt-note-state.js");

interface ObservedFailureSnapshot {
  records: readonly MemoryRecord[];
  coverage: MemoryCoverage;
  fingerprint: string;
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function isLockBusyError(error: unknown): boolean {
  return error instanceof Error && /triple lock is busy/u.test(error.message);
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

/**
 * Private Claude Code PostToolUse / PostToolUseFailure hook handler.
 * Records unwrapped Bash/PowerShell failures as agent-origin failures, links
 * fixes on pass when a pending marker exists, and returns a prior-attempts
 * additionalContext payload when eligible and delivered. Fail-open and never throws.
 */
export async function toolResultHook(stdin: Uint8Array, startedAt?: number): Promise<string> {
  const started = startedAt ?? performance.now();
  try {
    if (stdin.byteLength > TOOL_RESULT_STDIN_CAP_BYTES) return EMPTY_RESPONSE;
    const payload: unknown = JSON.parse(DECODER.decode(stdin));
    const decoder = await loadHarnessDecoder("claude-code");
    const decoded = decoder?.decodeHook(payload);
    if (decoder === undefined || decoded === undefined) return EMPTY_RESPONSE;
    const event = projectToToolResult(decoded);
    if (event === undefined) return EMPTY_RESPONSE;

    if (event.kind === "pass") {
      if (!existsSync(resolveRockyPaths().pending)) return EMPTY_RESPONSE;
      const { resolveFixOnSuccess } = await import("../core/memory.js");
      const result = resolveFixOnSuccess(event.cmd, event.cwd, {
        agent: event.agent,
        lockWaitMs: TOOL_RESULT_LOCK_WAIT_MS,
      });
      await refreshFixTouchAfterFix(result.fix, { home: resolveRockyPaths().home, now: Date.now() });
      return EMPTY_RESPONSE;
    }

    if (event.kind === "skip") {
      if (process.env.ROCKY_ATTEMPT_ADVISORY === "off") return EMPTY_RESPONSE;
      if (decoded.eventName !== "PostToolUseFailure") return EMPTY_RESPONSE;
      const stateMod = await import("../core/attempt-note-state.js");
      if (stateMod.noteAdvisoryEnabled(process.env)) {
        appendSkipRow(stateMod, resolveRockyPaths().home, {
          ts: Date.now(),
          session: decoded.sessionId ?? null,
          // The shell projection validated this field before returning a skip.
          cwd: (payload as { cwd: string }).cwd,
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

    let result;
    try {
      result = recordAgentFailure<ObservedFailureSnapshot | undefined>(
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
          observe: (snapshot) => (enabled ? snapshot : undefined),
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

    const snapshot = result.observed;
    if (!enabled || stateMod === undefined || snapshot === undefined) {
      return EMPTY_RESPONSE;
    }

    let note: AttemptNote | undefined;
    try {
      const [noteMod, cardsMod] = await Promise.all([
        import("../core/attempt-note.js"),
        import("../desk/cards-read.js"),
      ]);
      const cardsFor = cardsMod.makeCardsFor({
        home,
        toolText: cardsMod.toolTextAllowed(home),
      });
      note = noteMod.priorAttemptsNote(
        snapshot.records,
        snapshot.coverage,
        { fingerprints: [snapshot.fingerprint], cwd: event.cwd },
        { now, cardsFor, platform: process.platform },
      );
    } catch {
      note = undefined;
    }

    if (note === undefined) {
      return EMPTY_RESPONSE;
    }

    const session = event.agent.session;
    const arm = stateMod.attemptArm(session, process.env);
    const wouldShow = arm === "shown" || arm === "human";
    const claimed = wouldShow && stateMod.claimNoteSlot(home, session, note.key, now);
    const stdout = claimed ? renderSyncResponse(decoder, note.text) : EMPTY_RESPONSE;
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
      bytes: delivered ? note.bytes : 0,
    });

    return stdout;
  } catch {
    // Fail open: the tool-result hook must never block or fail the host.
  }
  return EMPTY_RESPONSE;
}
