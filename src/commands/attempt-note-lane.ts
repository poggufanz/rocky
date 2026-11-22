/**
 * Shared lane-1 entry point for the prior-attempts note across `rocky run`,
 * `rocky watch`, and the shell hook's `_hookfail` handler.
 *
 * Computes the note from an already-loaded memory snapshot before the new
 * failure is appended, decides arm assignment and once-per-session / cooldown
 * delivery, strips the `rocky: ` prefix so callers can pass the line directly
 * to `say()` / `sayTty()`, and returns a `finish(anchorFailureId, delivered)`
 * callback that appends the exposure row after the failure record is written
 * using the caller's actual output delivery result.
 *
 * Strictly fail-open: every error is swallowed so note or exposure bookkeeping
 * never alters a wrapped command's exit code, output, or hook outcome.
 */

import { performance } from "node:perf_hooks";
import { agentStampFromEnv } from "../core/agent-session.js";
import { priorAttemptsNote } from "../core/attempt-note.js";
import {
  appendExposure,
  attemptArm,
  claimNoteSlot,
  cwdHash,
  noteAdvisoryEnabled,
} from "../core/attempt-note-state.js";
import type { MemoryCoverage, MemoryRecord } from "../core/memory-read.js";
import { makeCardsFor, toolTextAllowed } from "../desk/cards-read.js";
import { OUTPUT_PREFIX } from "../ui/rocky.js";

export interface LaneOneNoteInput {
  lane: "run" | "watch" | "hookfail";
  records: readonly MemoryRecord[];
  coverage: MemoryCoverage;
  fingerprints: readonly string[];
  cwd: string;
  now: number;
  env: NodeJS.ProcessEnv;
  home: string;
  quiet?: boolean;
}

export interface PreparedLaneOneNote {
  text: string | undefined;
  finish(anchorFailureId: string | null, delivered: boolean): void;
}

const PREFIX_WITH_SPACE = `${OUTPUT_PREFIX} `;

const NOOP_PREPARED: PreparedLaneOneNote = {
  text: undefined,
  finish(_anchorFailureId: string | null, _delivered: boolean): void {},
};

function stripOutputPrefix(text: string): string {
  return text.startsWith(PREFIX_WITH_SPACE) ? text.slice(PREFIX_WITH_SPACE.length) : text;
}

export function prepareLaneOneNote(input: LaneOneNoteInput): PreparedLaneOneNote {
  try {
    if (!noteAdvisoryEnabled(input.env)) return NOOP_PREPARED;

    const started = performance.now();
    const cardsFor = makeCardsFor({
      home: input.home,
      toolText: toolTextAllowed(input.home),
    });
    const note = priorAttemptsNote(
      input.records,
      input.coverage,
      { fingerprints: input.fingerprints, cwd: input.cwd },
      { now: input.now, cardsFor, platform: process.platform },
    );
    if (note === undefined) return NOOP_PREPARED;

    const session = agentStampFromEnv(input.env)?.session;
    const arm = attemptArm(session, input.env);
    const wouldShow = !input.quiet && (arm === "shown" || arm === "human");
    const claimed = wouldShow && claimNoteSlot(input.home, session, note.key, input.now);
    const text = claimed ? stripOutputPrefix(note.text) : undefined;
    const latencyMs = Math.max(0, Math.round(performance.now() - started));

    let finished = false;
    return {
      text,
      finish(anchorFailureId: string | null, delivered: boolean): void {
        if (finished) return;
        finished = true;
        try {
          appendExposure(input.home, {
            v: 1,
            ts: input.now,
            session: session ?? null,
            lane: input.lane,
            kind: "note",
            arm,
            key: note.key,
            cwdHash: cwdHash(input.cwd),
            anchorFailureId,
            latencyMs,
            delivered: text !== undefined && delivered,
            bytes: note.bytes,
          });
        } catch {
          // Fail open: exposure logging must never disrupt a command or hook.
        }
      },
    };
  } catch {
    return NOOP_PREPARED;
  }
}
