import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ARMS, DEFAULT_SEED, mulberry32 } from "./runner.mjs";

const EVAL_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_MANIFEST_PATH = join(EVAL_DIR, "tasks", "manifest.json");

export const MAX_EXACT_SIGN_FLIP_N = 24;
export const DEFAULT_BOOTSTRAP_RESAMPLES = 10000;
export const DEFAULT_BOOTSTRAP_LEVEL = 0.9;

const SIGN_FLIP_GRID_SCALE = 1e9;
const CLAIM_P_THRESHOLD = 0.05;
const VETO_SOLVED_DROP_NUM = 1;
const VETO_SOLVED_DROP_DEN = 5;
const VETO_MEDIAN_TURN_RISE = 3;
const NOT_DELIVERED_MAX_NUM = 1;
const NOT_DELIVERED_MAX_DEN = 5;

/** @type {any[] | null} */
let cachedDefaultTasks = null;

function loadDefaultTasks() {
  if (cachedDefaultTasks === null) {
    const manifest = JSON.parse(readFileSync(DEFAULT_MANIFEST_PATH, "utf8"));
    cachedDefaultTasks = Array.isArray(manifest.tasks) ? manifest.tasks : [];
  }
  return cachedDefaultTasks;
}

/**
 * Arithmetic mean of finite numbers, or `null` when empty.
 * @param {readonly number[]} values
 * @returns {number | null}
 */
export function mean(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  let sum = 0;
  for (const v of values) {
    sum += v;
  }
  return sum / values.length;
}

/**
 * Sample median of finite numbers (average of middle two for even length), or `null` when empty.
 * Does not mutate `values`.
 * @param {readonly number[]} values
 * @returns {number | null}
 */
export function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function quantileSorted(sorted, q) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
}

function normalizeRuns(runs) {
  if (Array.isArray(runs)) {
    return runs.filter((r) => r && typeof r === "object");
  }
  if (runs && typeof runs === "object") {
    const out = [];
    for (const [runId, entry] of Object.entries(runs)) {
      if (!entry || typeof entry !== "object") continue;
      out.push(entry.runId ? entry : { runId, ...entry });
    }
    return out;
  }
  return [];
}

function buildTaskKindMap(tasks) {
  /** @type {Map<string, string>} */
  const map = new Map();
  if (tasks === undefined || tasks === null) {
    for (const task of loadDefaultTasks()) {
      if (task && typeof task.id === "string" && typeof task.kind === "string") {
        map.set(task.id, task.kind);
      }
    }
    return map;
  }
  if (tasks instanceof Map) {
    for (const [id, entry] of tasks.entries()) {
      const kind = typeof entry === "string" ? entry : entry?.kind;
      if (typeof id === "string" && typeof kind === "string") {
        map.set(id, kind);
      }
    }
    return map;
  }
  if (Array.isArray(tasks)) {
    for (const task of tasks) {
      if (task && typeof task.id === "string" && typeof task.kind === "string") {
        map.set(task.id, task.kind);
      }
    }
    return map;
  }
  if (typeof tasks === "object") {
    for (const [id, entry] of Object.entries(tasks)) {
      const kind = typeof entry === "string" ? entry : entry?.kind;
      if (typeof kind === "string") {
        map.set(id, kind);
      }
    }
  }
  return map;
}

function taskKindOf(run, kindMap) {
  if (run.taskId === "SMOKE") return "smoke";
  const fromMap = kindMap.get(run.taskId);
  if (fromMap) return fromMap;
  if (typeof run.kind === "string") return run.kind;
  return "unknown";
}

function isInvalidRun(run) {
  return run.invalid !== null && run.invalid !== undefined;
}

function orderedArmsFor(runs) {
  const seen = new Set(ARMS);
  const extra = new Set();
  for (const run of runs) {
    if (typeof run.arm === "string" && run.arm.length > 0 && !seen.has(run.arm)) {
      extra.add(run.arm);
    }
  }
  return [...ARMS, ...Array.from(extra).sort()];
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Exact two-sided paired sign-flip test over per-task differences.
 * Quantizes each diff onto a 1e-9 integer grid (`Math.round(d * 1e9)`), drops
 * values that quantize to zero, and enumerates all `2^nEffective` sign
 * assignments in exact integer arithmetic to compute `P(|sum| >= |observed|)`.
 * Throws when `nEffective > 24` or when `sum(|q_i|) >= Number.MAX_SAFE_INTEGER`.
 * @param {readonly number[]} diffs
 * @returns {{ p: number, nEffective: number }}
 */
export function signFlipP(diffs) {
  if (!Array.isArray(diffs)) {
    throw new TypeError("signFlipP requires an array of finite numbers");
  }

  // ponytail: diffs are quantized onto a 1e-9 integer grid (`Math.round(d * 1e9)`),
  // so inputs not on a 1e-9 grid are rounded (fine for k-run means of integer counts
  // over small k). Exactness requires sum(|q_i|) < Number.MAX_SAFE_INTEGER.
  /** @type {number[]} */
  const quantized = [];
  let sumAbs = 0;
  for (let i = 0; i < diffs.length; i += 1) {
    const value = diffs[i];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError(`signFlipP received non-finite diff at index ${i}: ${String(value)}`);
    }
    const q = Math.round(value * SIGN_FLIP_GRID_SCALE);
    if (!Number.isSafeInteger(q)) {
      throw new RangeError(
        `signFlipP quantized diff at index ${i} exceeds Number.MAX_SAFE_INTEGER`,
      );
    }
    if (q === 0) {
      continue;
    }
    const absQ = Math.abs(q);
    if (absQ >= Number.MAX_SAFE_INTEGER - sumAbs) {
      throw new RangeError(
        `signFlipP sum of quantized magnitudes must stay below Number.MAX_SAFE_INTEGER`,
      );
    }
    sumAbs += absQ;
    quantized.push(q);
  }

  const nEffective = quantized.length;
  if (nEffective === 0) {
    return { p: 1, nEffective: 0 };
  }
  if (nEffective > MAX_EXACT_SIGN_FLIP_N) {
    throw new Error(
      `signFlipP exact enumeration supports at most ${MAX_EXACT_SIGN_FLIP_N} non-zero diffs (2^${MAX_EXACT_SIGN_FLIP_N} exact enumeration is the feasible bound; the frozen set has 10 trap tasks), got ${nEffective}`,
    );
  }

  let observed = 0;
  for (const q of quantized) {
    observed += q;
  }
  const target = Math.abs(observed);

  // Sign vectors come in negated pairs with identical |sum|, so fixing the
  // first sign to +1 halves the enumeration without changing the exact ratio.
  let extremeCount = 0;
  function walk(index, acc) {
    if (index === nEffective) {
      if (Math.abs(acc) >= target) {
        extremeCount += 1;
      }
      return;
    }
    const q = quantized[index];
    walk(index + 1, acc + q);
    walk(index + 1, acc - q);
  }

  walk(1, quantized[0]);
  const halfTotal = 2 ** (nEffective - 1);
  return { p: extremeCount / halfTotal, nEffective };
}

/**
 * Two-stage percentile bootstrap confidence interval:
 * stage 1 resamples tasks with replacement; stage 2 resamples runs within each
 * sampled task with replacement. Uses `mulberry32` from `runner.mjs`.
 * @param {readonly any[] | Map<any, any>} perTask
 * @param {(sampledTasks: any[]) => number} statFn
 * @param {{ resamples?: number, level?: number, seed?: number }} [options]
 * @returns {[number, number] | [null, null]}
 */
export function bootstrapCI(
  perTask,
  statFn,
  {
    resamples = DEFAULT_BOOTSTRAP_RESAMPLES,
    level = DEFAULT_BOOTSTRAP_LEVEL,
    seed = DEFAULT_SEED,
  } = {},
) {
  if (typeof statFn !== "function") {
    throw new TypeError("bootstrapCI requires a statFn function");
  }
  if (!Number.isInteger(resamples) || resamples < 1) {
    throw new RangeError(`bootstrapCI resamples must be a positive integer, got ${String(resamples)}`);
  }
  if (typeof level !== "number" || !Number.isFinite(level) || level <= 0 || level >= 1) {
    throw new RangeError(`bootstrapCI level must be in (0, 1), got ${String(level)}`);
  }
  if (typeof seed !== "number" || !Number.isFinite(seed)) {
    throw new TypeError(`bootstrapCI seed must be a finite number, got ${String(seed)}`);
  }

  let tasks;
  if (Array.isArray(perTask)) {
    tasks = perTask;
  } else if (perTask instanceof Map) {
    tasks = Array.from(perTask.values());
  } else {
    throw new TypeError("bootstrapCI requires perTask to be an Array or Map");
  }

  if (tasks.length === 0) {
    return [null, null];
  }

  const rng = mulberry32(seed);

  function resampleArray(arr) {
    const len = arr.length;
    const out = new Array(len);
    for (let i = 0; i < len; i += 1) {
      out[i] = arr[Math.floor(rng() * len)];
    }
    return out;
  }

  function resampleTask(entry) {
    if (Array.isArray(entry)) {
      return resampleArray(entry);
    }
    if (entry instanceof Map) {
      const cloned = new Map();
      for (const [k, v] of entry.entries()) {
        cloned.set(k, Array.isArray(v) ? resampleArray(v) : v);
      }
      return cloned;
    }
    if (entry && typeof entry === "object") {
      /** @type {Record<string, any>} */
      const cloned = {};
      for (const key of Object.keys(entry)) {
        const v = entry[key];
        cloned[key] = Array.isArray(v) ? resampleArray(v) : v;
      }
      return cloned;
    }
    return entry;
  }

  const samples = new Float64Array(resamples);
  const taskCount = tasks.length;
  for (let r = 0; r < resamples; r += 1) {
    const draw = new Array(taskCount);
    for (let t = 0; t < taskCount; t += 1) {
      const picked = tasks[Math.floor(rng() * taskCount)];
      draw[t] = resampleTask(picked);
    }
    const stat = statFn(draw);
    if (typeof stat !== "number" || !Number.isFinite(stat)) {
      throw new Error(`bootstrapCI statFn returned non-finite value: ${String(stat)}`);
    }
    samples[r] = stat;
  }

  samples.sort();
  const alpha = 1 - level;
  return [
    quantileSorted(samples, alpha / 2),
    quantileSorted(samples, 1 - alpha / 2),
  ];
}

/**
 * Compute per-task, per-arm arithmetic means for `metric`.
 * Excludes invalid runs (`invalid !== null`) and `"no_attempt"` values;
 * converts booleans to `1`/`0`. Tasks/arms whose runs are all excluded map to
 * `undefined`. Per-(task, arm) exclusion counts are attached on `.counts`
 * (non-enumerable) as `Map<taskId, Map<arm, { included, noAttempt, invalid, missing, total }>>`.
 * @param {readonly any[] | Record<string, any>} runs
 * @param {string} metric
 * @returns {Map<string, Map<string, number | undefined>> & { counts: Map<string, Map<string, { included: number, noAttempt: number, invalid: number, missing: number, total: number }>> }}
 */
export function perTaskMeans(runs, metric) {
  if (typeof metric !== "string" || metric.length === 0) {
    throw new TypeError("perTaskMeans requires a non-empty metric name");
  }

  const list = normalizeRuns(runs);
  /** @type {Map<string, Map<string, { sum: number, included: number, noAttempt: number, invalid: number, missing: number, total: number }>>} */
  const buckets = new Map();

  for (const run of list) {
    if (typeof run.taskId !== "string" || typeof run.arm !== "string") continue;
    let armMap = buckets.get(run.taskId);
    if (!armMap) {
      armMap = new Map();
      buckets.set(run.taskId, armMap);
    }
    let acc = armMap.get(run.arm);
    if (!acc) {
      acc = { sum: 0, included: 0, noAttempt: 0, invalid: 0, missing: 0, total: 0 };
      armMap.set(run.arm, acc);
    }
    acc.total += 1;

    if (isInvalidRun(run)) {
      acc.invalid += 1;
      continue;
    }

    const raw = run[metric];
    if (raw === "no_attempt") {
      acc.noAttempt += 1;
      continue;
    }
    if (typeof raw === "boolean") {
      acc.sum += raw ? 1 : 0;
      acc.included += 1;
      continue;
    }
    if (typeof raw === "number" && Number.isFinite(raw)) {
      acc.sum += raw;
      acc.included += 1;
      continue;
    }
    acc.missing += 1;
  }

  /** @type {Map<string, Map<string, number | undefined>>} */
  const result = new Map();
  /** @type {Map<string, Map<string, { included: number, noAttempt: number, invalid: number, missing: number, total: number }>>} */
  const counts = new Map();

  const sortedTasks = Array.from(buckets.keys()).sort(compareStrings);
  for (const taskId of sortedTasks) {
    const armMap = buckets.get(taskId);
    const armNames = [
      ...ARMS.filter((arm) => armMap.has(arm)),
      ...Array.from(armMap.keys()).filter((arm) => !ARMS.includes(arm)).sort(compareStrings),
    ];
    const meanArmMap = new Map();
    const countArmMap = new Map();
    for (const arm of armNames) {
      const acc = armMap.get(arm);
      meanArmMap.set(arm, acc.included > 0 ? acc.sum / acc.included : undefined);
      countArmMap.set(arm, {
        included: acc.included,
        noAttempt: acc.noAttempt,
        invalid: acc.invalid,
        missing: acc.missing,
        total: acc.total,
      });
    }
    result.set(taskId, meanArmMap);
    counts.set(taskId, countArmMap);
  }

  Object.defineProperty(result, "counts", {
    value: counts,
    enumerable: false,
  });
  return /** @type {any} */ (result);
}

function meanPairedDiff(sampledTasks) {
  let sum = 0;
  for (const task of sampledTasks) {
    const firstMean = mean(task.first);
    const secondMean = mean(task.second);
    sum += firstMean - secondMean;
  }
  return sum / sampledTasks.length;
}

/**
 * Compute claims, harm veto, positive-control rate, leak status, exclusions,
 * and descriptive staleRepeat rates for an eval batch.
 * `SMOKE` runs are never analysed.
 * @param {{
 *   runs?: readonly any[] | Record<string, any>,
 *   metrics?: readonly any[] | Record<string, any>,
 *   tasks?: readonly any[] | Record<string, any> | Map<string, any>,
 *   provenance?: any,
 *   label?: string,
 *   run1InformedChange?: boolean,
 *   heldOutTrapTasks?: number,
 *   ownerCheck?: { leak?: boolean, [key: string]: any } | null,
 *   seed?: number,
 *   resamples?: number,
 *   level?: number,
 * }} batch
 */
export function verdict(batch) {
  if (!batch || typeof batch !== "object") {
    throw new TypeError("verdict requires a batch object");
  }

  const rawRuns = normalizeRuns(batch.runs ?? batch.metrics ?? []);
  const kindMap = buildTaskKindMap(batch.tasks);
  const runs = rawRuns.filter((run) => taskKindOf(run, kindMap) !== "smoke");
  const arms = orderedArmsFor(runs);

  const label = typeof batch.label === "string"
    ? batch.label
    : (typeof batch.provenance?.label === "string" ? batch.provenance.label : null);
  const normalizedLabel = label !== null ? label.trim().toLowerCase() : null;
  const run1InformedChange =
    (batch.run1InformedChange ?? batch.provenance?.run1InformedChange) === true;
  const heldOutTrapTasksRaw = batch.heldOutTrapTasks ?? batch.provenance?.heldOutTrapTasks;
  const heldOutTrapTasks =
    typeof heldOutTrapTasksRaw === "number" && Number.isFinite(heldOutTrapTasksRaw)
      ? heldOutTrapTasksRaw
      : null;

  const seed = typeof batch.seed === "number"
    ? batch.seed
    : (typeof batch.provenance?.seed === "number" ? batch.provenance.seed : DEFAULT_SEED);
  const resamples = batch.resamples ?? DEFAULT_BOOTSTRAP_RESAMPLES;
  const level = batch.level ?? DEFAULT_BOOTSTRAP_LEVEL;

  /** @type {Record<string, number>} */
  const excluded = {};
  /** @type {Record<string, number>} */
  const leaksByArm = {};
  for (const arm of arms) {
    excluded[arm] = 0;
    leaksByArm[arm] = 0;
  }

  /** @type {Array<{ runId: string | null, taskId: string | null, arm: string | null, reasons: string[] }>} */
  const leakRuns = [];

  for (const run of runs) {
    if (isInvalidRun(run) && typeof run.arm === "string") {
      excluded[run.arm] = (excluded[run.arm] ?? 0) + 1;
    }

    const reasons = Array.isArray(run.leak)
      ? run.leak.filter((item) => typeof item === "string" && item.length > 0)
      : [];
    if (run.invalid === "token_leak" && !reasons.includes("token-in-transcript")) {
      reasons.push("token-in-transcript");
    }
    if (reasons.length > 0) {
      if (typeof run.arm === "string") {
        leaksByArm[run.arm] = (leaksByArm[run.arm] ?? 0) + 1;
      }
      leakRuns.push({
        runId: typeof run.runId === "string" ? run.runId : null,
        taskId: typeof run.taskId === "string" ? run.taskId : null,
        arm: typeof run.arm === "string" ? run.arm : null,
        reasons,
      });
    }
  }

  const ownerLeak = Boolean(batch.ownerCheck && batch.ownerCheck.leak === true);
  const validRuns = runs.filter((run) => !isInvalidRun(run));

  // Positive control: all `after` trap runs (including invalid runs); `not_delivered` = `noteDelivered === false`.
  const allAfterTrapRuns = runs.filter(
    (run) => taskKindOf(run, kindMap) === "trap" && run.arm === "after",
  );
  const notDeliveredCount = allAfterTrapRuns.filter((run) => run.noteDelivered === false).length;
  const afterTrapTotal = allAfterTrapRuns.length;
  const notDeliveredRate = afterTrapTotal > 0 ? notDeliveredCount / afterTrapTotal : null;
  const notDeliveredExceeded =
    afterTrapTotal > 0
    && notDeliveredCount * NOT_DELIVERED_MAX_DEN > afterTrapTotal * NOT_DELIVERED_MAX_NUM;

  const validAfterTrapRuns = allAfterTrapRuns.filter((run) => !isInvalidRun(run));
  const validNotDeliveredCount = validAfterTrapRuns.filter((run) => run.noteDelivered === false).length;
  const validAfterTrapTotal = validAfterTrapRuns.length;
  const validNotDeliveredRate = validAfterTrapTotal > 0 ? validNotDeliveredCount / validAfterTrapTotal : null;
  const invalidAfterTrapTotal = afterTrapTotal - validAfterTrapTotal;
  const invalidNotDeliveredCount = notDeliveredCount - validNotDeliveredCount;

  /** @type {Record<string, boolean>} */
  const armValid = {};
  for (const arm of arms) {
    armValid[arm] =
      !ownerLeak
      && (leaksByArm[arm] ?? 0) === 0
      && !(arm === "after" && notDeliveredExceeded);
  }
  const anyLeak = ownerLeak || leakRuns.length > 0;
  const batchValid = !notDeliveredExceeded && !anyLeak;

  // Claims: trap tasks only, paired per-task differences on repeatFailures.
  const trapRuns = runs.filter((run) => taskKindOf(run, kindMap) === "trap");
  const trapRepeatMeans = perTaskMeans(trapRuns, "repeatFailures");
  const trapSolvedMeans = perTaskMeans(trapRuns, "solved");

  /** @type {Map<string, Map<string, number[]>>} */
  const trapRepeatValues = new Map();
  for (const run of trapRuns) {
    if (isInvalidRun(run)) continue;
    if (typeof run.repeatFailures !== "number" || !Number.isFinite(run.repeatFailures)) continue;
    let armMap = trapRepeatValues.get(run.taskId);
    if (!armMap) {
      armMap = new Map();
      trapRepeatValues.set(run.taskId, armMap);
    }
    let vals = armMap.get(run.arm);
    if (!vals) {
      vals = [];
      armMap.set(run.arm, vals);
    }
    vals.push(run.repeatFailures);
  }

  const trapTaskIds = Array.from(trapRepeatMeans.keys()).sort(compareStrings);
  const trapSolvedTaskIds = Array.from(trapSolvedMeans.keys()).sort(compareStrings);

  function trapSolvedMeanForArm(arm) {
    /** @type {number[]} */
    const vals = [];
    for (const taskId of trapSolvedTaskIds) {
      const m = trapSolvedMeans.get(taskId)?.get(arm);
      if (typeof m === "number" && Number.isFinite(m)) {
        vals.push(m);
      }
    }
    return mean(vals);
  }

  function authorizeClaim(comparisonKey, trigger) {
    if (!batchValid) {
      return { authorized: false, authorizationNote: "batch invalid" };
    }
    if (normalizedLabel === "run1") {
      return {
        authorized: false,
        authorizationNote: "run 1 serves veto and positive control only",
      };
    }
    if (normalizedLabel === "run2") {
      if (comparisonKey === "afterVsBefore" && run1InformedChange) {
        if (heldOutTrapTasks === null || heldOutTrapTasks < 10) {
          return {
            authorized: false,
            authorizationNote: "run-1-informed change requires >= 10 held-out trap tasks",
          };
        }
        return {
          authorized: trigger,
          authorizationNote: trigger
            ? "authorized (held-out trap tasks >= 10)"
            : "statistical trigger not met",
        };
      }
      return {
        authorized: trigger,
        authorizationNote: trigger ? "authorized" : "statistical trigger not met",
      };
    }
    return {
      authorized: false,
      authorizationNote: label !== null
        ? `label "${label}" is descriptive only`
        : "unlabeled run is descriptive only",
    };
  }

  function computeClaim(comparisonKey, firstArm, secondArm) {
    /** @type {Array<{ taskId: string, diff: number, firstValues: number[], secondValues: number[] }>} */
    const paired = [];
    for (const taskId of trapTaskIds) {
      const m1 = trapRepeatMeans.get(taskId)?.get(firstArm);
      const m2 = trapRepeatMeans.get(taskId)?.get(secondArm);
      if (m1 === undefined || m2 === undefined) continue;
      const v1 = trapRepeatValues.get(taskId)?.get(firstArm) ?? [];
      const v2 = trapRepeatValues.get(taskId)?.get(secondArm) ?? [];
      if (v1.length === 0 || v2.length === 0) continue;
      paired.push({
        taskId,
        diff: m1 - m2,
        firstValues: v1,
        secondValues: v2,
      });
    }

    const diffs = paired.map((item) => item.diff);
    const { p, nEffective } = signFlipP(diffs);
    const meanDiff = paired.length > 0 ? mean(diffs) : null;

    /** @type {"downward" | "upward" | "flat" | "none"} */
    let direction = "none";
    if (meanDiff !== null) {
      if (meanDiff < 0) direction = "downward";
      else if (meanDiff > 0) direction = "upward";
      else direction = "flat";
    }

    const ci = paired.length > 0
      ? bootstrapCI(
        paired.map((item) => ({ first: item.firstValues, second: item.secondValues })),
        meanPairedDiff,
        { resamples, level, seed },
      )
      : null;

    const solvedFirst = trapSolvedMeanForArm(firstArm);
    const solvedSecond = trapSolvedMeanForArm(secondArm);
    const solvedOk =
      solvedFirst !== null
      && solvedSecond !== null
      && solvedFirst >= solvedSecond - 1e-12;

    const trigger = Boolean(
      nEffective > 0
      && p <= CLAIM_P_THRESHOLD
      && direction === "downward"
      && solvedOk,
    );
    const { authorized, authorizationNote } = authorizeClaim(comparisonKey, trigger);

    return {
      n: nEffective,
      nPaired: paired.length,
      meanDiff,
      p,
      ci,
      direction,
      solvedFirst,
      solvedSecond,
      solvedOk,
      trigger,
      authorized,
      authorizationNote,
      claimed: authorized,
    };
  }

  const claims = {
    afterVsNone: computeClaim("afterVsNone", "after", "none"),
    afterVsBefore: computeClaim("afterVsBefore", "after", "before"),
    beforeVsNone: computeClaim("beforeVsNone", "before", "none"),
  };

  // Harm veto: pools valid control and stale runs.
  const vetoRuns = validRuns.filter((run) => {
    const kind = taskKindOf(run, kindMap);
    return kind === "control" || kind === "stale";
  });

  const noneSolvedRuns = vetoRuns.filter((run) => run.arm === "none" && typeof run.solved === "boolean");
  const afterSolvedRuns = vetoRuns.filter((run) => run.arm === "after" && typeof run.solved === "boolean");
  let noneSolvedMean = null;
  let afterSolvedMean = null;
  let solvedDrop = null;
  let solvedVetoed = false;
  if (noneSolvedRuns.length > 0 && afterSolvedRuns.length > 0) {
    const noneSolvedCount = noneSolvedRuns.filter((run) => run.solved).length;
    const afterSolvedCount = afterSolvedRuns.filter((run) => run.solved).length;
    noneSolvedMean = noneSolvedCount / noneSolvedRuns.length;
    afterSolvedMean = afterSolvedCount / afterSolvedRuns.length;
    solvedDrop = noneSolvedMean - afterSolvedMean;
    // Exact rational comparison for solvedDrop >= 1/5 (avoids 1.0 - 0.8 = 0.19999999999999996).
    solvedVetoed =
      VETO_SOLVED_DROP_DEN * (noneSolvedCount * afterSolvedRuns.length - afterSolvedCount * noneSolvedRuns.length)
      >= VETO_SOLVED_DROP_NUM * noneSolvedRuns.length * afterSolvedRuns.length;
  }

  const noneTurns = vetoRuns
    .filter((run) => run.arm === "none" && typeof run.numTurns === "number" && Number.isFinite(run.numTurns))
    .map((run) => run.numTurns);
  const afterTurns = vetoRuns
    .filter((run) => run.arm === "after" && typeof run.numTurns === "number" && Number.isFinite(run.numTurns))
    .map((run) => run.numTurns);
  const noneMedianTurns = median(noneTurns);
  const afterMedianTurns = median(afterTurns);
  const medianTurnRise =
    noneMedianTurns !== null && afterMedianTurns !== null
      ? afterMedianTurns - noneMedianTurns
      : null;
  const turnVetoed = medianTurnRise !== null && medianTurnRise >= VETO_MEDIAN_TURN_RISE;

  const veto = {
    solvedDrop,
    medianTurnRise,
    solvedVetoed,
    turnVetoed,
    vetoed: Boolean(solvedVetoed || turnVetoed),
    noneSolvedMean,
    afterSolvedMean,
    noneMedianTurns,
    afterMedianTurns,
    pooledCounts: {
      none: vetoRuns.filter((run) => run.arm === "none").length,
      after: vetoRuns.filter((run) => run.arm === "after").length,
    },
  };

  // Descriptive only: staleRepeat rate per arm over valid stale runs.
  /** @type {Record<string, number | null>} */
  const staleRepeatRate = {};
  const staleRuns = validRuns.filter((run) => taskKindOf(run, kindMap) === "stale");
  for (const arm of arms) {
    const armStale = staleRuns.filter(
      (run) => run.arm === arm && typeof run.staleRepeat === "boolean",
    );
    staleRepeatRate[arm] = armStale.length > 0
      ? armStale.filter((run) => run.staleRepeat).length / armStale.length
      : null;
  }

  return {
    claims,
    veto,
    notDeliveredRate,
    notDelivered: {
      count: notDeliveredCount,
      total: afterTrapTotal,
      rate: notDeliveredRate,
      validCount: validNotDeliveredCount,
      validTotal: validAfterTrapTotal,
      validRate: validNotDeliveredRate,
      invalidCount: invalidNotDeliveredCount,
      invalidTotal: invalidAfterTrapTotal,
    },
    batchValid,
    armValid,
    excluded,
    leaks: {
      byArm: leaksByArm,
      runs: leakRuns,
      ownerLeak,
      any: anyLeak,
    },
    staleRepeatRate,
  };
}
