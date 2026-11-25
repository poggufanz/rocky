import { existsSync } from "node:fs";
import { join } from "node:path";
import { joinAttemptCards } from "../core/attempt-cards.js";
import { buildProblems, type Attempt, type ProblemEntry } from "../core/attempts.js";
import {
  FIXTOUCH_WINDOW_MS, fixTouchCachePath, fixTouchEnabled, writeFixTouchCache, type FixTouchEntry,
} from "../core/fixtouch-cache.js";
import { createMemoryQueries, loadDurableMemorySnapshot } from "../core/memory-query.js";
import { loadMemoryChecked, tailReadable } from "../core/memory-read.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import { makeCardsFor, resolveGitRootForCwd, toolTextAllowed } from "../desk/cards-read.js";

interface CollectOptions {
  now: number;
  rootFor: (cwd: string) => string;
  platform: NodeJS.Platform;
}

function isRecentPass(attempt: Attempt, cutoff: number): boolean {
  return attempt.outcome === "passed" && attempt.ts >= cutoff;
}

export function collectFixTouchEntries(entries: readonly ProblemEntry[], opts: CollectOptions): FixTouchEntry[] {
  const cutoff = opts.now - FIXTOUCH_WINDOW_MS;
  const hot: FixTouchEntry[] = [];
  for (const entry of entries) {
    let root: string | undefined;
    for (const attempt of entry.attempts) {
      if (!isRecentPass(attempt, cutoff) || attempt.changes.state !== "observed") continue;
      for (const path of attempt.changes.files) {
        root ??= opts.rootFor(entry.cwd);
        hot.push({ root, path, cmd: attempt.cmd, signature: entry.signature[0] ?? "", ts: attempt.ts });
      }
    }
  }
  return hot.sort((a, b) => b.ts - a.ts);
}

export function rebuildFixTouchCache({ home, now }: { home: string; now: number }): boolean {
  // The query factory reads the configured home. A caller can supply a different home.
  const snapshot = home === resolveRockyPaths().home
    ? loadDurableMemorySnapshot(createMemoryQueries(), now)
    : loadMemoryChecked(join(home, "memory.jsonl"), now);
  if (snapshot === undefined || !tailReadable(snapshot.coverage)) return false;

  const { records, coverage } = snapshot;
  const problems = buildProblems(records, coverage, { now });
  const cutoff = now - FIXTOUCH_WINDOW_MS;
  const candidates = problems.entries.filter((entry) => entry.attempts.some((attempt) => isRecentPass(attempt, cutoff)));
  const platform = process.platform;
  const cardsFor = makeCardsFor({ home, toolText: toolTextAllowed(home) });
  const joined = joinAttemptCards(candidates, records, cardsFor, { platform });
  const entries = collectFixTouchEntries(joined.entries, {
    now,
    platform,
    rootFor: (cwd) => resolveGitRootForCwd(cwd, existsSync) ?? cwd,
  });
  if (!fixTouchEnabled(home)) return false;
  return writeFixTouchCache(fixTouchCachePath(home), { v: 1, builtAt: now, entries }, {
    beforePublish: () => fixTouchEnabled(home),
  });
}
