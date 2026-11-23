import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_BOOTSTRAP_LEVEL,
  DEFAULT_BOOTSTRAP_RESAMPLES,
  median,
  perTaskMeans,
  verdict,
} from "./analyze.mjs";
import { ARMS, DEFAULT_SEED } from "./runner.mjs";

const EVAL_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_MANIFEST_PATH = join(EVAL_DIR, "tasks", "manifest.json");

export const POSITIVE_CONTROL_SOURCE =
  "note text in a tool result or a delivered note row in the run's advisories.jsonl";

export const RUN_BOUNDARY_RULE =
  "Run-1 per-task results serve only for veto and positive control. If the note template, selection logic, or attempts read model is changed after run 1 using run-1 transcripts, a run-2 `after − before` claim requires at least 10 new trap tasks frozen before that change; without a new frozen trap set, that run-2 comparison is descriptive only.";

const USAGE = [
  "Usage: node scripts/eval/report.mjs --out <dir> --label <label> --dest <md path>",
  "         [--seed <n>] [--resamples <n>]",
  "",
  "Options:",
  "  --out <dir>        Batch output directory containing metrics.json and batch.json",
  "  --label <label>    Report label (for example: run1, run2)",
  "  --dest <path>      Destination markdown file path",
  "  --seed <n>         Override bootstrap PRNG seed (default: batch.json seed)",
  `  --resamples <n>    Bootstrap resamples (default: ${DEFAULT_BOOTSTRAP_RESAMPLES})`,
  "  -h, --help         Show this help message and exit",
].join("\n");

function readJsonOrNull(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeTextAtomic(targetPath, content) {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(tempPath, content, "utf8");
    renameSync(tempPath, targetPath);
  } finally {
    if (existsSync(tempPath)) {
      rmSync(tempPath, { force: true });
    }
  }
}

function escapeCell(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function fmtFloat(value, digits = 3) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return value.toFixed(digits);
}

function fmtPercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

function fmtInt(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return String(Math.round(value));
}

function fmtNumberOrHalf(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function fmtCi(ci) {
  if (!Array.isArray(ci) || ci.length !== 2 || ci[0] === null || ci[1] === null) {
    return "n/a";
  }
  return `[${fmtFloat(ci[0], 3)}, ${fmtFloat(ci[1], 3)}]`;
}

function normalizeMetricsEntries(metrics) {
  if (Array.isArray(metrics)) {
    return metrics.filter((entry) => entry && typeof entry === "object");
  }
  if (metrics && typeof metrics === "object") {
    return Object.entries(metrics)
      .filter(([, entry]) => entry && typeof entry === "object")
      .map(([runId, entry]) => (entry.runId ? entry : { runId, ...entry }));
  }
  return [];
}

function buildKindLookup(manifest) {
  /** @type {Map<string, string>} */
  const map = new Map();
  const tasks = Array.isArray(manifest?.tasks) ? manifest.tasks : [];
  for (const task of tasks) {
    if (task && typeof task.id === "string" && typeof task.kind === "string") {
      map.set(task.id, task.kind);
    }
  }
  return map;
}

function taskKindFor(taskId, kindMap, fallbackKind) {
  if (taskId === "SMOKE") return "smoke";
  return kindMap.get(taskId) ?? (typeof fallbackKind === "string" ? fallbackKind : "unknown");
}

function orderedArms(runs) {
  const known = new Set(ARMS);
  const extra = new Set();
  for (const run of runs) {
    if (typeof run.arm === "string" && run.arm.length > 0 && !known.has(run.arm)) {
      extra.add(run.arm);
    }
  }
  return [...ARMS, ...Array.from(extra).sort()];
}

function sortTaskIds(taskIds, manifest) {
  const order = new Map();
  const tasks = Array.isArray(manifest?.tasks) ? manifest.tasks : [];
  tasks.forEach((task, idx) => {
    if (task && typeof task.id === "string") {
      order.set(task.id, idx);
    }
  });
  return [...taskIds].sort((a, b) => {
    const ia = order.has(a) ? order.get(a) : Number.MAX_SAFE_INTEGER;
    const ib = order.has(b) ? order.get(b) : Number.MAX_SAFE_INTEGER;
    if (ia !== ib) return ia - ib;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * Render the markdown evaluation report from scored metrics, provenance, and verdict.
 * @param {{
 *   label: string,
 *   provenance?: any,
 *   metrics: Record<string, any> | readonly any[],
 *   manifest: any,
 *   verdict: ReturnType<typeof verdict>,
 *   seed: number,
 *   resamples: number,
 *   level: number,
 *   ownerCheck?: any,
 * }} data
 * @returns {string}
 */
export function renderReport({
  label,
  provenance,
  metrics,
  manifest,
  verdict: v,
  seed,
  resamples,
  level,
  ownerCheck,
}) {
  const allRuns = normalizeMetricsEntries(metrics);
  const kindMap = buildKindLookup(manifest);
  const smokeRuns = allRuns.filter((run) => taskKindFor(run.taskId, kindMap, run.kind) === "smoke");
  const analysedRuns = allRuns.filter((run) => taskKindFor(run.taskId, kindMap, run.kind) !== "smoke");
  const arms = orderedArms(analysedRuns);

  const lines = [];
  lines.push(`# Attempt Memory Eval Report — ${label}`);
  lines.push("");

  // 1. Provenance
  lines.push("## Provenance");
  lines.push("");
  const prov = provenance && typeof provenance === "object" ? provenance : {};
  const claudeMdHashes = prov.claudeMdSha256 && typeof prov.claudeMdSha256 === "object"
    ? Object.entries(prov.claudeMdSha256)
      .map(([arm, hash]) => `${arm}=\`${hash}\``)
      .join(", ")
    : "n/a";
  const provenanceRows = [
    ["Label", label],
    ["Started at", prov.startedAt ?? "n/a"],
    ["Model", prov.model ?? "n/a"],
    ["Claude version", prov.claudeVersion ?? "n/a"],
    ["Claude flags", Array.isArray(prov.claudeFlags) ? `\`${prov.claudeFlags.join(" ")}\`` : "n/a"],
    ["Before commit", prov.beforeSha ? `\`${prov.beforeSha}\` (${prov.beforeRef ?? "n/a"})` : "n/a"],
    ["After commit", prov.afterSha ? `\`${prov.afterSha}\` (${prov.afterRef ?? "n/a"})` : "n/a"],
    ["Evaluator commit", prov.evaluatorCommit ? `\`${prov.evaluatorCommit}\`` : "n/a"],
    ["Task set sha256", prov.taskSetSha256 ? `\`${prov.taskSetSha256}\`` : "n/a"],
    ["CLAUDE.md sha256", claudeMdHashes],
    ["Seed", String(seed)],
    ["Blocks (k)", prov.k !== undefined ? String(prov.k) : "n/a"],
    ["Concurrency", prov.concurrency !== undefined ? String(prov.concurrency) : "n/a"],
    ["Auth mode", prov.auth ?? "n/a"],
    ["Tasks scheduled", Array.isArray(prov.taskIds) ? prov.taskIds.join(", ") : "n/a"],
    ["Bootstrap", `${resamples} resamples, ${(level * 100).toFixed(0)}% two-stage CI (seed ${seed})`],
  ];
  lines.push("| Field | Value |");
  lines.push("|---|---|");
  for (const [field, value] of provenanceRows) {
    lines.push(`| ${escapeCell(field)} | ${escapeCell(value)} |`);
  }
  lines.push("");

  // 2. Excluded runs per arm
  lines.push("## Excluded Runs");
  lines.push("");
  if (smokeRuns.length > 0) {
    lines.push(
      `Note: ${smokeRuns.length} SMOKE run(s) present in metrics.json were omitted because SMOKE is never analysed.`,
    );
    lines.push("");
  }
  lines.push("| Arm | Total runs | Valid runs | Excluded runs | Reasons |");
  lines.push("|---|---:|---:|---:|---|");
  for (const arm of arms) {
    const armRuns = analysedRuns.filter((run) => run.arm === arm);
    const invalidRuns = armRuns.filter((run) => run.invalid !== null && run.invalid !== undefined);
    const reasonCounts = new Map();
    for (const run of invalidRuns) {
      const key = String(run.invalid);
      reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
    }
    const reasonText = reasonCounts.size > 0
      ? Array.from(reasonCounts.entries())
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([reason, count]) => `${reason}=${count}`)
        .join(", ")
      : "none";
    lines.push(
      `| ${escapeCell(arm)} | ${armRuns.length} | ${armRuns.length - invalidRuns.length} | ${invalidRuns.length} | ${escapeCell(reasonText)} |`,
    );
  }
  lines.push("");

  // 3. Leak results
  lines.push("## Leak Results");
  lines.push("");
  lines.push("| Arm | Leaking runs | Arm valid |");
  lines.push("|---|---:|---|");
  for (const arm of arms) {
    const count = v.leaks.byArm[arm] ?? 0;
    const valid = v.armValid[arm] ? "valid" : "invalid";
    lines.push(`| ${escapeCell(arm)} | ${count} | ${valid} |`);
  }
  lines.push("");
  if (v.leaks.runs.length > 0) {
    lines.push("Leaking runs:");
    for (const item of v.leaks.runs) {
      lines.push(`- \`${item.runId ?? "unknown"}\` (${item.taskId ?? "unknown"} / ${item.arm ?? "unknown"}): ${item.reasons.join(", ")}`);
    }
    lines.push("");
  }
  if (ownerCheck && typeof ownerCheck === "object") {
    lines.push(
      `- Owner check: leak=${ownerCheck.leak === true ? "true" : "false"}, appendedUnderEvalRoot=${ownerCheck.appendedUnderEvalRoot ?? 0}, settingsChanged=${Array.isArray(ownerCheck.settingsChanged) ? ownerCheck.settingsChanged.length : 0}.`,
    );
  } else {
    lines.push("- Owner check: not attached to batch (default: no owner leak).");
  }
  lines.push(`- Overall batch validity: **${v.batchValid ? "valid" : "invalid"}**.`);
  lines.push("");

  // 4. Positive control (not_delivered)
  lines.push("## Positive Control");
  lines.push("");
  lines.push(`Positive-control source: ${POSITIVE_CONTROL_SOURCE}.`);
  lines.push("");
  const nd = v.notDelivered;
  const ndRateText = nd.rate === null ? "n/a (0 checked after trap runs)" : `${nd.count}/${nd.total} (${fmtPercent(nd.rate)})`;
  const ndPassText = nd.rate === null
    ? "n/a"
    : (nd.count * 5 > nd.total ? "FAIL (> 20% threshold; batch invalid)" : "PASS (<= 20% threshold)");
  lines.push(`- \`not_delivered\` over \`after\` trap runs: ${ndRateText}`);
  lines.push(`- Positive-control status: ${ndPassText}`);
  lines.push("");

  // 5. Per-task x arm table
  lines.push("## Per-Task Metrics");
  lines.push("");
  const taskIds = sortTaskIds(
    Array.from(new Set(analysedRuns.map((run) => run.taskId).filter((id) => typeof id === "string"))),
    manifest,
  );
  if (taskIds.length === 0) {
    lines.push("No non-smoke tasks present in this batch.");
    lines.push("");
  } else {
    const repeatMeans = perTaskMeans(analysedRuns, "repeatFailures");
    const solvedMeans = perTaskMeans(analysedRuns, "solved");
    const noteBytesMeans = perTaskMeans(analysedRuns, "noteBytes");

    lines.push(
      "| Task | Kind | Arm | Mean repeatFailures | no_attempt | Mean solved | Median turnsToPass | Median wallMs | Mean noteBytes |",
    );
    lines.push("|---|---|---|---:|---:|---:|---:|---:|---:|");

    for (const taskId of taskIds) {
      const taskRuns = analysedRuns.filter((run) => run.taskId === taskId);
      const kind = taskKindFor(taskId, kindMap, taskRuns[0]?.kind);
      for (const arm of arms) {
        const cellRuns = taskRuns.filter((run) => run.arm === arm);
        if (cellRuns.length === 0) continue;
        const validCell = cellRuns.filter((run) => run.invalid === null || run.invalid === undefined);

        const repeatMean = repeatMeans.get(taskId)?.get(arm);
        const noAttemptCount = repeatMeans.counts.get(taskId)?.get(arm)?.noAttempt ?? 0;
        const solvedMean = solvedMeans.get(taskId)?.get(arm);
        const noteBytesMean = noteBytesMeans.get(taskId)?.get(arm);

        const turnsToPassVals = validCell
          .map((run) => run.turnsToPass)
          .filter((val) => typeof val === "number" && Number.isFinite(val));
        const wallMsVals = validCell
          .map((run) => run.wallMs)
          .filter((val) => typeof val === "number" && Number.isFinite(val));

        lines.push(
          `| ${escapeCell(taskId)} | ${escapeCell(kind)} | ${escapeCell(arm)} | ${fmtFloat(repeatMean, 3)} | ${noAttemptCount} | ${fmtFloat(solvedMean, 3)} | ${fmtNumberOrHalf(median(turnsToPassVals))} | ${fmtInt(median(wallMsVals))} | ${fmtFloat(noteBytesMean, 1)} |`,
        );
      }
    }
    lines.push("");
  }

  // Descriptive staleRepeat rates
  lines.push("### Stale Tasks (`staleRepeat` Rate, Descriptive Only)");
  lines.push("");
  lines.push("This metric is descriptive only and feeds no claim or veto.");
  lines.push("");
  lines.push("| Arm | staleRepeat rate |");
  lines.push("|---|---:|");
  for (const arm of arms) {
    const rate = v.staleRepeatRate[arm];
    lines.push(`| ${escapeCell(arm)} | ${rate === null || rate === undefined ? "n/a" : fmtFloat(rate, 3)} |`);
  }
  lines.push("");

  // 6. Comparisons
  lines.push("## Comparisons");
  lines.push("");
  if (!v.batchValid) {
    lines.push(
      "Batch is invalid; comparisons below are reported for diagnostic transparency only and support no claim.",
    );
    lines.push("");
  }
  lines.push(
    "Paired per-task trap comparisons on `repeatFailures` (exact two-sided sign-flip test over non-zero differences; two-stage 90% bootstrap CI over all paired trap tasks).",
  );
  lines.push("");
  lines.push("| Comparison | n (eff) | Paired | Mean diff | p | 90% CI | Direction | solvedOk | Claimed |");
  lines.push("|---|---:|---:|---:|---:|---|---|---|---|");
  const comparisonRows = [
    ["afterVsNone (after - none)", v.claims.afterVsNone],
    ["afterVsBefore (after - before)", v.claims.afterVsBefore],
    ["beforeVsNone (before - none)", v.claims.beforeVsNone],
  ];
  for (const [name, c] of comparisonRows) {
    lines.push(
      `| ${escapeCell(name)} | ${c.n} | ${c.nPaired} | ${fmtFloat(c.meanDiff, 3)} | ${fmtFloat(c.p, 4)} | ${fmtCi(c.ci)} | ${escapeCell(c.direction)} | ${c.solvedOk ? "yes" : "no"} | ${c.claimed ? "yes" : "no"} |`,
    );
  }
  lines.push("");

  // 7. Veto and verdict
  lines.push("## Veto and Verdict");
  lines.push("");
  lines.push("Pooled over valid control and stale runs (`none` vs `after`):");
  lines.push("");
  lines.push("| Check | Value | Threshold | Triggered |");
  lines.push("|---|---:|---|---|");
  lines.push(
    `| solvedDrop (none - after) | ${fmtFloat(v.veto.solvedDrop, 3)} | >= 0.200 | ${v.veto.solvedVetoed ? "yes" : "no"} |`,
  );
  lines.push(
    `| medianTurnRise (after - none, numTurns) | ${fmtNumberOrHalf(v.veto.medianTurnRise)} | >= 3 | ${v.veto.turnVetoed ? "yes" : "no"} |`,
  );
  lines.push("");

  let verdictSummary;
  if (!v.batchValid) {
    verdictSummary = "Batch invalid — no veto or claim decision recorded.";
  } else if (v.veto.solvedDrop === null && v.veto.medianTurnRise === null) {
    verdictSummary = "No control or stale runs present — veto not evaluated.";
  } else if (v.veto.vetoed) {
    verdictSummary = "Vetoed — harm threshold exceeded on pooled control and stale runs.";
  } else {
    verdictSummary = "Not vetoed — harm thresholds not exceeded.";
  }
  lines.push(`- **Batch valid:** ${v.batchValid}`);
  lines.push(`- **Vetoed:** ${v.veto.vetoed}`);
  lines.push(`- **Verdict:** ${verdictSummary}`);
  lines.push("");

  // 8. Run-boundary rule
  lines.push("## Run-Boundary Rule");
  lines.push("");
  lines.push(RUN_BOUNDARY_RULE);
  lines.push("");

  return `${lines.join("\n")}`;
}

/**
 * Load batch outputs from `outDir`, compute verdict, render markdown, and
 * optionally write to `dest`.
 * @param {string} outDir
 * @param {{
 *   label: string,
 *   dest?: string,
 *   manifest?: any,
 *   seed?: number,
 *   resamples?: number,
 *   level?: number,
 * }} options
 */
export function generateReport(outDir, options) {
  const resolvedOut = resolve(outDir);
  const metricsPath = join(resolvedOut, "metrics.json");
  if (!existsSync(metricsPath)) {
    throw new Error(`metrics.json not found in ${resolvedOut}`);
  }
  const metrics = JSON.parse(readFileSync(metricsPath, "utf8"));
  const provenance = readJsonOrNull(join(resolvedOut, "batch.json"));
  const manifest = options.manifest ?? JSON.parse(readFileSync(DEFAULT_MANIFEST_PATH, "utf8"));

  const seed = typeof options.seed === "number"
    ? options.seed
    : (typeof provenance?.seed === "number" ? provenance.seed : DEFAULT_SEED);
  const resamples = options.resamples ?? DEFAULT_BOOTSTRAP_RESAMPLES;
  const level = options.level ?? DEFAULT_BOOTSTRAP_LEVEL;
  const ownerCheck = provenance?.ownerCheck ?? null;

  const v = verdict({
    runs: metrics,
    tasks: manifest.tasks,
    provenance,
    ownerCheck,
    seed,
    resamples,
    level,
  });

  const markdown = renderReport({
    label: options.label,
    provenance,
    metrics,
    manifest,
    verdict: v,
    seed,
    resamples,
    level,
    ownerCheck,
  });

  let destPath = null;
  if (typeof options.dest === "string" && options.dest.length > 0) {
    destPath = resolve(options.dest);
    writeTextAtomic(destPath, markdown);
  }

  return { markdown, verdict: v, destPath };
}

function usageError(message) {
  process.stderr.write(`Error: ${message}\n`);
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}

function parseIntArg(flag, value) {
  if (!/^-?\d+$/.test(value)) {
    usageError(`${flag} requires an integer, got: ${value}`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    usageError(`${flag} integer out of range: ${value}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const opts = {
    help: false,
    out: undefined,
    label: undefined,
    dest: undefined,
    seed: undefined,
    resamples: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
      return opts;
    }
    const takeValue = (name) => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        usageError(`${name} requires a value`);
      }
      i += 1;
      return next;
    };
    if (arg === "--out") {
      opts.out = takeValue("--out");
    } else if (arg === "--label") {
      opts.label = takeValue("--label");
    } else if (arg === "--dest") {
      opts.dest = takeValue("--dest");
    } else if (arg === "--seed") {
      opts.seed = parseIntArg("--seed", takeValue("--seed"));
    } else if (arg === "--resamples") {
      opts.resamples = parseIntArg("--resamples", takeValue("--resamples"));
      if (opts.resamples < 1) {
        usageError("--resamples must be >= 1");
      }
    } else {
      usageError(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (!opts.out) usageError("--out <dir> is required");
  if (!opts.label) usageError("--label <label> is required");
  if (!opts.dest) usageError("--dest <md path> is required");

  const { destPath, verdict: v } = generateReport(opts.out, {
    label: opts.label,
    dest: opts.dest,
    seed: opts.seed,
    resamples: opts.resamples,
  });
  process.stdout.write(
    `wrote ${destPath} (batchValid=${v.batchValid} vetoed=${v.veto.vetoed})\n`,
  );
}

export function isMainModule(
  argv1 = process.argv[1],
  metaUrl = import.meta.url,
  realpath = realpathSync.native,
) {
  if (!argv1) return false;
  try {
    return realpath(resolve(argv1)) === realpath(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main();
}
