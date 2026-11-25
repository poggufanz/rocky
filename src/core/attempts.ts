import { createHash } from "node:crypto";
import { commandFingerprint, commandIdentity } from "./fingerprint.js";
import {
  canonicalFingerprint,
  fingerprintMigrationIndex,
  LINK_WINDOW_MS,
  queryRecall,
  type FingerprintMigrationIndex,
} from "./memory-query.js";
import {
  cwdIdentityKey,
  differentAgentSession,
  isOperationalMemoryRecord,
  tailReadable,
  type AssociationRecord,
  type FailureRecord,
  type FixRecord,
  type MemoryCoverage,
  type MemoryRecord,
  type RationaleRecord,
} from "./memory-read.js";
import { sanitizeTestimony } from "./redact.js";

export type AttemptOutcome =
  | "passed" | "possible_pass" | "same_failure" | "different_failure" | "no_later_run" | "unknown";

export interface Attempt {
  failureId: string; ts: number; cmd: string;
  outcome: AttemptOutcome; outcomeRecordId?: string; outcomeTs?: number;
  nextFingerprint?: string;
  unknownReason?: "coverage" | "unlinked-pass";
  session?: { vendor: string; agentId?: string }; sessionScoped: boolean; crossSession?: true;
  changes: { state: "observed"; files: string[]; more: number; cardId: string; partial: boolean }
         | { state: "testimony"; files: string[]; rationaleId: string }
         | { state: "unknown" };
  stated?: { text: string; source: "bash-description" | "card-quote" | "rationale"; recordId: string };
  expectations?: { text: string; command?: string; rationaleId: string;
    observed: "same_command_passed" | "same_command_failed" | "no_matching_run" | "not_comparable" }[];
}

export interface ProblemEntry {
  problemId: string; key: string; fingerprint: string; family: string[];
  keyStrength: "output" | "command";
  cwd: string; cwdScope?: "here" | "elsewhere";
  firstSeenTs: number; lastSeenTs: number; signature: string[];
  counts: Record<AttemptOutcome, number> & { attempts: number };
  latestOutcome: AttemptOutcome; attempts: Attempt[]; historyMayStartEarlier: boolean;
}

export interface ProblemSet { entries: ProblemEntry[]; coverage: MemoryCoverage; ungroupedLegacy: number }

export interface ProblemSelection { set: ProblemSet; entries: ProblemEntry[]; cutoffTs?: number }

const THIRTY_DAYS_MS = 30 * 86_400_000;
const FINGERPRINT_HEX_RE = /^[0-9a-f]{16}$/u;

interface IndexedFailure {
  kind: "failure";
  record: FailureRecord;
  order: number;
  cwdKey: string;
  keyStrength: "output" | "command";
  canonical: string;
  key: string;
  cwdIndex: number;
}

interface IndexedFix {
  kind: "fix";
  record: FixRecord;
  order: number;
  cwdKey: string;
  cwdIndex: number;
}

type IndexedRunRecord = IndexedFailure | IndexedFix;

interface IndexedAssociation {
  record: AssociationRecord;
  order: number;
  cwdKey: string;
}

interface IndexedRationale {
  record: RationaleRecord;
  order: number;
}

type Expectation = NonNullable<Attempt["expectations"]>[number];

interface FailureGroup {
  key: string;
  problemId?: string;
  canonical: string;
  keyStrength: "output" | "command";
  cwdKey: string;
  family: Set<string>;
  failures: IndexedFailure[];
}

function sha256Hex16(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function addToMapArray<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, [value]);
  else existing.push(value);
}

function cachedCommandFingerprint(
  cache: Map<number, Map<string, string>>,
  cmd: string,
  exitCode: number,
): string {
  let byCmd = cache.get(exitCode);
  if (byCmd === undefined) {
    byCmd = new Map<string, string>();
    cache.set(exitCode, byCmd);
  }
  let fp = byCmd.get(cmd);
  if (fp === undefined) {
    fp = commandFingerprint(cmd, exitCode);
    byCmd.set(cmd, fp);
  }
  return fp;
}

function keyStrengthOf(
  record: FailureRecord,
  cmdFpCache: Map<number, Map<string, string>>,
): "output" | "command" {
  if (record.origin === "hook") return "command";
  if (record.fingerprintV === 2 && Array.isArray(record.signature)) {
    return record.signature.length === 0 ? "command" : "output";
  }
  return record.fingerprint === cachedCommandFingerprint(cmdFpCache, record.cmd, record.exitCode)
    ? "command"
    : "output";
}

function compareByTsOrder(a: { record: { ts: number }; order: number }, b: { record: { ts: number }; order: number }): number {
  return a.record.ts - b.record.ts || a.order - b.order;
}

function findMatchingAssociation(
  associations: readonly IndexedAssociation[] | undefined,
  failure: FailureRecord,
  cwdKey: string,
  windowEnd: number,
): AssociationRecord | undefined {
  if (associations === undefined || associations.length === 0) return undefined;
  let best: IndexedAssociation | undefined;
  for (let i = 0; i < associations.length; i += 1) {
    const candidate = associations[i]!;
    const record = candidate.record;
    if (candidate.cwdKey !== cwdKey) continue;
    if (record.ts <= failure.ts || record.ts > windowEnd) continue;
    if (differentAgentSession(failure.agent, record.agent)) continue;
    if (best === undefined || compareByTsOrder(candidate, best) < 0) {
      best = candidate;
    }
  }
  return best?.record;
}

function observeExpectation(
  rationale: RationaleRecord,
  cwdRuns: readonly IndexedRunRecord[],
  defaultPlatform: NodeJS.Platform,
): Expectation["observed"] {
  const command = rationale.expectedCommand;
  if (command === undefined || command.trim().length === 0) return "not_comparable";
  const defaultIdentity = commandIdentity(command, { platform: defaultPlatform });
  if (!defaultIdentity.reliable) return "not_comparable";
  const identities = new Map([[defaultPlatform, defaultIdentity]]);

  let lo = 0;
  let hi = cwdRuns.length;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (cwdRuns[mid]!.record.ts <= rationale.ts) lo = mid + 1;
    else hi = mid;
  }

  const windowEnd = rationale.ts + LINK_WINDOW_MS;
  // ponytail: Rationales carry no session stamp. Filter on agent.session once they do.
  for (let index = lo; index < cwdRuns.length; index += 1) {
    const { record } = cwdRuns[index]!;
    if (record.ts > windowEnd) break;
    if (record.identityReliable !== true) continue;
    const platform = record.platform ?? defaultPlatform;
    let expected = identities.get(platform);
    if (expected === undefined) {
      expected = commandIdentity(command, { platform });
      identities.set(platform, expected);
    }
    if (expected.reliable && expected.value === record.commandIdentity) {
      return record.kind === "fix" ? "same_command_passed" : "same_command_failed";
    }
  }
  return "no_matching_run";
}

function buildTestimony(
  rationales: readonly IndexedRationale[] | undefined,
  cwdRuns: readonly IndexedRunRecord[],
  defaultPlatform: NodeJS.Platform,
): Pick<Attempt, "changes" | "stated" | "expectations"> {
  if (rationales === undefined || rationales.length === 0) {
    return { changes: { state: "unknown" } };
  }
  let newestAny: IndexedRationale | undefined;
  let newestWithFiles: IndexedRationale | undefined;
  let mcpRationales: IndexedRationale[] | undefined;
  for (let i = 0; i < rationales.length; i += 1) {
    const item = rationales[i]!;
    if (item.record.source === "mcp") {
      (mcpRationales ??= []).push(item);
      continue;
    }
    if (newestAny === undefined || compareByTsOrder(item, newestAny) > 0) {
      newestAny = item;
    }
    if (item.record.files !== undefined && item.record.files.length > 0) {
      if (newestWithFiles === undefined || compareByTsOrder(item, newestWithFiles) > 0) {
        newestWithFiles = item;
      }
    }
  }
  const changes: Attempt["changes"] = newestWithFiles !== undefined
    ? {
        state: "testimony",
        files: [...newestWithFiles.record.files!],
        rationaleId: newestWithFiles.record.id,
      }
    : { state: "unknown" };
  const stated: Attempt["stated"] = newestAny !== undefined
    ? {
        text: sanitizeTestimony(newestAny.record.excerpt),
        source: "rationale",
        recordId: newestAny.record.id,
      }
    : undefined;
  const testimony: Pick<Attempt, "changes" | "stated" | "expectations"> = { changes };
  if (stated !== undefined) testimony.stated = stated;
  if (mcpRationales !== undefined) {
    testimony.expectations = mcpRationales.sort(compareByTsOrder).map(({ record }) => ({
      text: sanitizeTestimony(record.excerpt),
      ...(record.expectedCommand === undefined ? {} : { command: sanitizeTestimony(record.expectedCommand) }),
      rationaleId: record.id,
      observed: observeExpectation(record, cwdRuns, defaultPlatform),
    }));
  }
  return testimony;
}

function emptyCounts(): Record<AttemptOutcome, number> & { attempts: number } {
  return {
    attempts: 0,
    passed: 0,
    possible_pass: 0,
    same_failure: 0,
    different_failure: 0,
    no_later_run: 0,
    unknown: 0,
  };
}

function indexAssociation(
  associationsByFailureId: Map<string, IndexedAssociation[]>,
  record: AssociationRecord,
  order: number,
  cwdKey: string,
): void {
  const indexed: IndexedAssociation = { record, order, cwdKey };
  if (
    record.candidateFailureIds.length === 1 &&
    record.links.length === 1 &&
    record.candidateFailureIds[0] === record.links[0]!.id
  ) {
    addToMapArray(associationsByFailureId, record.candidateFailureIds[0]!, indexed);
    return;
  }
  const linkedIds = new Set<string>(record.candidateFailureIds);
  for (const link of record.links) linkedIds.add(link.id);
  for (const failureId of linkedIds) {
    addToMapArray(associationsByFailureId, failureId, indexed);
  }
}

export function buildProblems(
  records: readonly MemoryRecord[],
  coverage: MemoryCoverage,
  opts: { now: number; fingerprint?: string; cwd?: string; platform?: NodeJS.Platform },
): ProblemSet {
  const defaultPlatform = opts.platform ?? process.platform;
  const targetFilter = opts.fingerprint;
  const seenIds = new Set<string>();
  const failureRecords: FailureRecord[] = [];
  const failureOrders: number[] = [];
  const fixesById = new Map<string, FixRecord>();
  const associationsByFailureId = new Map<string, IndexedAssociation[]>();
  const rationalesByFailureId = new Map<string, IndexedRationale[]>();
  const deferredFixes: Array<{ record: FixRecord; order: number }> = [];
  const deferredAssociations: Array<{ record: AssociationRecord; order: number }> = [];
  const deferredRationales: Array<{ record: RationaleRecord; order: number }> = [];
  const collectNonFailuresNow = targetFilter === undefined;

  for (let order = 0; order < records.length; order += 1) {
    const record = records[order]!;
    if (seenIds.has(record.id)) continue;
    seenIds.add(record.id);
    if (!isOperationalMemoryRecord(record, opts.now)) continue;

    if (record.kind === "failure") {
      failureRecords.push(record);
      failureOrders.push(order);
    } else if (record.kind === "fix") {
      if (collectNonFailuresNow) {
        fixesById.set(record.id, record);
        deferredFixes.push({ record, order });
      } else {
        deferredFixes.push({ record, order });
      }
    } else if (record.kind === "association") {
      if (collectNonFailuresNow) {
        const cwdKey = cwdIdentityKey(record.cwd, record.platform ?? defaultPlatform);
        indexAssociation(associationsByFailureId, record, order, cwdKey);
      } else {
        deferredAssociations.push({ record, order });
      }
    } else if (record.kind === "rationale" && record.links?.failureId !== undefined) {
      if (collectNonFailuresNow) {
        addToMapArray(rationalesByFailureId, record.links.failureId, { record, order });
      } else {
        deferredRationales.push({ record, order });
      }
    }
  }

  if (failureRecords.length === 0) {
    return { entries: [], coverage, ungroupedLegacy: 0 };
  }

  const migration: FingerprintMigrationIndex = fingerprintMigrationIndex(failureRecords);
  const cmdFpCache = new Map<number, Map<string, string>>();
  const recordsByCwdKey = new Map<string, IndexedRunRecord[]>();
  const groups = new Map<string, FailureGroup>();
  const cwdKeyCache = new Map<string, string>();
  const resolveCwdKey = (cwd: string, platform: NodeJS.Platform | undefined): string => {
    const resolvedPlatform = platform ?? defaultPlatform;
    if (resolvedPlatform !== "win32") return cwd;
    let cached = cwdKeyCache.get(cwd);
    if (cached === undefined) {
      cached = cwdIdentityKey(cwd, "win32");
      cwdKeyCache.set(cwd, cached);
    }
    return cached;
  };

  let ungroupedLegacy = 0;

  for (let i = 0; i < failureRecords.length; i += 1) {
    const record = failureRecords[i]!;
    const order = failureOrders[i]!;
    const canonical = canonicalFingerprint(record, migration);
    const keyStrength = keyStrengthOf(record, cmdFpCache);
    const cwdKey = resolveCwdKey(record.cwd, record.platform);
    const key = `${keyStrength}:${canonical}:${cwdKey}`;
    if (record.fingerprintV !== 2 && !migration.provenLegacyRecords.has(record.id)) {
      ungroupedLegacy += 1;
    }

    const indexed: IndexedFailure = {
      kind: "failure",
      record,
      order,
      cwdKey,
      keyStrength,
      canonical,
      key,
      cwdIndex: -1,
    };
    addToMapArray(recordsByCwdKey, cwdKey, indexed);

    let group = groups.get(key);
    if (group === undefined) {
      group = {
        key,
        canonical,
        keyStrength,
        cwdKey,
        family: new Set([record.fingerprint]),
        failures: [indexed],
      };
      groups.set(key, group);
    } else {
      group.family.add(record.fingerprint);
      group.failures.push(indexed);
    }
  }

  const keptGroups: FailureGroup[] = [];
  const neededCwdKeys = new Set<string>();
  const neededFailureIds = targetFilter !== undefined ? new Set<string>() : undefined;

  for (const group of groups.values()) {
    if (targetFilter !== undefined) {
      const directMatch = group.canonical === targetFilter || group.family.has(targetFilter);
      if (!directMatch) {
        group.problemId = sha256Hex16(group.key);
        if (group.problemId !== targetFilter) continue;
      }
      for (let i = 0; i < group.failures.length; i += 1) {
        neededFailureIds!.add(group.failures[i]!.record.id);
      }
    }
    keptGroups.push(group);
    neededCwdKeys.add(group.cwdKey);
  }

  if (keptGroups.length === 0) {
    return { entries: [], coverage, ungroupedLegacy };
  }

  // Selected attempts can observe runs from other fingerprints in the same directory.
  for (let i = 0; i < deferredFixes.length; i += 1) {
    const { record, order } = deferredFixes[i]!;
    const cwdKey = resolveCwdKey(record.cwd, record.platform);
    if (!neededCwdKeys.has(cwdKey)) continue;
    if (!collectNonFailuresNow) fixesById.set(record.id, record);
    addToMapArray(recordsByCwdKey, cwdKey, {
      kind: "fix",
      record,
      order,
      cwdKey,
      cwdIndex: -1,
    });
  }

  if (!collectNonFailuresNow) {
    for (let i = 0; i < deferredAssociations.length; i += 1) {
      const { record, order } = deferredAssociations[i]!;
      const cwdKey = resolveCwdKey(record.cwd, record.platform);
      if (!neededCwdKeys.has(cwdKey)) continue;
      indexAssociation(associationsByFailureId, record, order, cwdKey);
    }
    for (let i = 0; i < deferredRationales.length; i += 1) {
      const { record, order } = deferredRationales[i]!;
      const failureId = record.links?.failureId;
      if (failureId !== undefined && neededFailureIds!.has(failureId)) {
        addToMapArray(rationalesByFailureId, failureId, { record, order });
      }
    }
  }

  for (const cwdKey of neededCwdKeys) {
    const list = recordsByCwdKey.get(cwdKey);
    if (list === undefined) continue;
    list.sort(compareByTsOrder);
    for (let index = 0; index < list.length; index += 1) {
      list[index]!.cwdIndex = index;
    }
  }

  const tailWindow = coverage.window === "tail";
  const tailIsReadable = tailReadable(coverage);
  const entries: ProblemEntry[] = [];

  for (let gIdx = 0; gIdx < keptGroups.length; gIdx += 1) {
    const group = keptGroups[gIdx]!;
    group.failures.sort(compareByTsOrder);
    const cwdList = recordsByCwdKey.get(group.cwdKey)!;
    const attempts: Attempt[] = [];
    const counts = emptyCounts();

    for (let fIdx = 0; fIdx < group.failures.length; fIdx += 1) {
      const fItem = group.failures[fIdx]!;
      const failure = fItem.record;
      const windowEnd = failure.ts + LINK_WINDOW_MS;
      const failureReliable = failure.identityReliable === true && failure.commandIdentity !== undefined;

      let outcome: AttemptOutcome | undefined;
      let outcomeRecordId: string | undefined;
      let outcomeTs: number | undefined;
      let nextFingerprint: string | undefined;
      let unknownReason: Attempt["unknownReason"];

      for (let index = fItem.cwdIndex + 1; index < cwdList.length; index += 1) {
        const candidate = cwdList[index]!;
        const candidateRecord = candidate.record;
        if (candidateRecord.ts > windowEnd) break;
        if (candidateRecord.ts <= failure.ts) continue;

        if (candidate.kind === "fix") {
          const fix = candidate.record;
          if (failure.resolvedBy === fix.id && fixesById.has(fix.id)) {
            outcome = "passed";
            outcomeRecordId = fix.id;
            outcomeTs = fix.ts;
            break;
          }
          if (differentAgentSession(failure.agent, fix.agent)) continue;
          if (failureReliable && fix.identityReliable === true && fix.commandIdentity === failure.commandIdentity) {
            outcome = "unknown";
            unknownReason = "unlinked-pass";
            outcomeRecordId = fix.id;
            outcomeTs = fix.ts;
            break;
          }
        } else {
          const nextFailure = candidate.record;
          if (differentAgentSession(failure.agent, nextFailure.agent)) continue;
          if (candidate.key === fItem.key) {
            outcome = "same_failure";
            outcomeRecordId = nextFailure.id;
            outcomeTs = nextFailure.ts;
            break;
          }
          if (
            failureReliable &&
            nextFailure.identityReliable === true &&
            nextFailure.commandIdentity === failure.commandIdentity
          ) {
            outcome = "different_failure";
            outcomeRecordId = nextFailure.id;
            outcomeTs = nextFailure.ts;
            nextFingerprint = candidate.canonical;
            break;
          }
        }
      }

      if (outcome === undefined) {
        const matchedAssociation = findMatchingAssociation(
          associationsByFailureId.get(failure.id),
          failure,
          group.cwdKey,
          windowEnd,
        );
        if (matchedAssociation !== undefined) {
          outcome = "possible_pass";
          outcomeRecordId = matchedAssociation.id;
          outcomeTs = matchedAssociation.ts;
        } else if (!tailIsReadable) {
          outcome = "unknown";
          unknownReason = "coverage";
        } else {
          outcome = "no_later_run";
        }
      }

      counts.attempts += 1;
      counts[outcome] += 1;

      const { changes, stated, expectations } = buildTestimony(
        rationalesByFailureId.get(failure.id), cwdList, defaultPlatform,
      );
      const session = failure.agent !== undefined
        ? (failure.agent.agentId !== undefined
            ? { vendor: failure.agent.vendor, agentId: failure.agent.agentId }
            : { vendor: failure.agent.vendor })
        : undefined;

      const attempt: Attempt = {
        failureId: failure.id,
        ts: failure.ts,
        cmd: failure.cmd,
        outcome,
        sessionScoped: failure.agent !== undefined,
        changes,
      };
      if (outcomeRecordId !== undefined) attempt.outcomeRecordId = outcomeRecordId;
      if (outcomeTs !== undefined) attempt.outcomeTs = outcomeTs;
      if (nextFingerprint !== undefined) attempt.nextFingerprint = nextFingerprint;
      if (unknownReason !== undefined) attempt.unknownReason = unknownReason;
      if (session !== undefined) attempt.session = session;
      if (stated !== undefined) attempt.stated = stated;
      if (expectations !== undefined) attempt.expectations = expectations;
      attempts.push(attempt);
    }

    const claimedPassIds = new Map<string, number>();
    for (let i = attempts.length - 1; i >= 0; i -= 1) {
      const attempt = attempts[i]!;
      if (attempt.outcome !== "passed" || attempt.outcomeRecordId === undefined) continue;
      const passId = attempt.outcomeRecordId;
      const keptIndex = claimedPassIds.get(passId);
      if (keptIndex === undefined) {
        claimedPassIds.set(passId, i);
      } else {
        const keptAttempt = attempts[keptIndex]!;
        const keptFailure = group.failures[keptIndex]!.record;
        const demotedFailure = group.failures[i]!.record;
        counts.passed -= 1;
        counts.same_failure += 1;
        attempt.outcome = "same_failure";
        attempt.outcomeRecordId = keptAttempt.failureId;
        attempt.outcomeTs = keptAttempt.ts;
        if (differentAgentSession(demotedFailure.agent, keptFailure.agent)) {
          attempt.crossSession = true;
        } else {
          delete attempt.crossSession;
        }
      }
    }

    const newestFailure = group.failures[group.failures.length - 1]!.record;
    const problemId = group.problemId ?? sha256Hex16(group.key);
    const entryPlatform = newestFailure.platform ?? defaultPlatform;

    const entry: ProblemEntry = {
      problemId,
      key: group.key,
      fingerprint: group.canonical,
      family: [...group.family].sort(),
      keyStrength: group.keyStrength,
      cwd: newestFailure.cwd,
      firstSeenTs: attempts[0]!.ts,
      lastSeenTs: attempts[attempts.length - 1]!.ts,
      signature: [...newestFailure.signature],
      counts,
      latestOutcome: attempts[attempts.length - 1]!.outcome,
      attempts,
      historyMayStartEarlier: tailWindow,
    };
    if (opts.cwd !== undefined) {
      entry.cwdScope = cwdIdentityKey(opts.cwd, entryPlatform) === group.cwdKey ? "here" : "elsewhere";
    }
    entries.push(entry);
  }

  entries.sort(
    (a, b) => b.lastSeenTs - a.lastSeenTs || (a.problemId < b.problemId ? -1 : a.problemId > b.problemId ? 1 : 0),
  );

  return {
    entries,
    coverage,
    ungroupedLegacy,
  };
}

export function selectProblemEntries(
  records: readonly MemoryRecord[],
  coverage: MemoryCoverage,
  opts: { now: number; cwd: string; query: string | undefined; allDirs: boolean; limit: number },
): ProblemSelection {
  const { now, cwd, query, allDirs, limit } = opts;

  if (query === undefined) {
    const cutoffTs = now - THIRTY_DAYS_MS;
    const set = buildProblems(records, coverage, { now, cwd });
    const recentCount = (entry: ProblemEntry): number => {
      let count = 0;
      for (const attempt of entry.attempts) {
        if (attempt.ts >= cutoffTs) count += 1;
      }
      return count;
    };
    const recentNonPassed = (entry: ProblemEntry): number => {
      let count = 0;
      for (const attempt of entry.attempts) {
        if (attempt.ts >= cutoffTs && attempt.outcome !== "passed") count += 1;
      }
      return count;
    };
    const entries = set.entries
      .filter((entry) => (allDirs || entry.cwdScope === "here") && recentCount(entry) >= 2)
      .sort((a, b) =>
        recentNonPassed(b) - recentNonPassed(a) ||
        b.lastSeenTs - a.lastSeenTs ||
        (a.problemId < b.problemId ? -1 : a.problemId > b.problemId ? 1 : 0),
      )
      .slice(0, limit);
    return { set, entries, cutoffTs };
  }

  if (FINGERPRINT_HEX_RE.test(query)) {
    const set = buildProblems(records, coverage, {
      now,
      fingerprint: query,
      cwd,
    });
    const entries = set.entries
      .filter((entry) => allDirs || entry.cwdScope === "here")
      .slice(0, limit);
    return { set, entries };
  }

  const set = buildProblems(records, coverage, { now, cwd });
  const hits = queryRecall(records, { query, limit: 50, now });
  const eligible = set.entries.filter((entry) => allDirs || entry.cwdScope === "here");
  const seenProblemIds = new Set<string>();
  const matched: ProblemEntry[] = [];
  for (const hit of hits) {
    for (const entry of eligible) {
      if (seenProblemIds.has(entry.problemId)) continue;
      if (entry.family.includes(hit.failure.fingerprint)) {
        seenProblemIds.add(entry.problemId);
        matched.push(entry);
        if (matched.length >= limit) break;
      }
    }
    if (matched.length >= limit) break;
  }
  return { set, entries: matched };
}
