/**
 * Collector loop. While its host process lives (the foreground GUI, or the
 * desktop daemon's capture process), every consented repo gets one
 * lease-guarded owner that reconciles on a bounded interval. A process that
 * loses the lease skips that repo; a revoked repo is released and stops
 * capturing, its history stays. MCP never imports this module
 * (mcp-import-boundary): MCP stays read-only.
 */
import { randomBytes } from "node:crypto";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { resolveRockyPaths } from "../core/state-paths.js";
import { detail, say } from "../ui/rocky.js";
import { releaseCollector, tryAcquireCollector, type CollectorOwner } from "./collector.js";
import { isRepoCaptureAllowed, listConsentedRepos, normalizeRepoRoot } from "./repo-consent-read.js";
import { reconcileRepo } from "./watcher.js";

// ponytail: interval reconcile, no fs.watch trigger; add one when edit latency under a tick matters.
// Must stay under COLLECTOR_LEASE_MS (30s): each tick's acquire renews the lease.
export const COLLECTOR_TICK_MS = 10_000;

/** How often the daemon's capture process re-walks a repo it owns; a `request` runs sooner. */
export const CAPTURE_FULL_EVERY_MS = 60_000;

export interface RootOwnership {
  root: string;
  owner: boolean;
}

/** One finished reconcile. Counts and a token only: file names never leave the worker. */
export interface ReconcileReport {
  root: string;
  coverage: "complete" | "partial" | "unknown";
  gaps: number;
  /** Set only when `coverage` is `"unknown"`. */
  reason?: "root-unusable" | "repo-consent-required" | "git-unreadable" | "not-a-repo" | "capture-failed";
  atMs: number;
}

export interface CollectorLoop {
  /** Run one tick soon, e.g. right after a consent change. */
  kick(): void;
  /** Reconcile one root now. Dropped unless capture is allowed for it. */
  request(root: string): void;
  /** Settles once the loop has ended: `"stopped"` after `stop()`, `"failed"` when the worker errored. */
  done: Promise<"stopped" | "failed">;
  /** Stop ticking, finish worker shutdown, then release every owned lease. */
  stop(): Promise<void>;
}

export function startCollectorLoop(opts: {
  proc: CollectorOwner["proc"];
  home?: string;
  tickMs?: number;
  /** No default, so every caller chooses: dash passes `COLLECTOR_TICK_MS` (reconcile on every tick). */
  fullEveryMs: number;
  onRoots?: (roots: RootOwnership[]) => void;
  onResult?: (report: ReconcileReport) => void;
}): CollectorLoop {
  const owner: CollectorOwner = { proc: opts.proc, pid: process.pid, token: randomBytes(16).toString("hex") };
  const home = opts.home ?? resolveRockyPaths().home;
  const tickMs = opts.tickMs ?? COLLECTOR_TICK_MS;
  // A tick already comes at least this late, so every tick reconciles. Comparing
  // timestamps instead would skip ticks whenever the timer fires a hair early.
  const reconcileEveryTick = opts.fullEveryMs <= tickMs;
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { rockyCollector: true, home },
    execArgv: [],
  });
  const owned = new Set<string>();
  const extra = new Set<string>();
  const known = new Map<string, boolean>();
  const pending = new Set<string>();
  const dirty = new Set<string>();
  const lastPostAt = new Map<string, number>();
  let stopped = false;
  let ticked = false;
  let lastRoots: string | undefined;

  const post = (root: string): void => {
    pending.add(root);
    lastPostAt.set(root, Date.now());
    worker.postMessage(root);
  };

  // A root we do not hold has no post history: whoever wins the lease next
  // reconciles it at once instead of waiting out `fullEveryMs`.
  const forfeit = (root: string): void => {
    owned.delete(root);
    dirty.delete(root);
    lastPostAt.delete(root);
  };

  const publishRoots = (): void => {
    if (!ticked || opts.onRoots === undefined) return;
    const roots = [...known]
      .map(([root, isOwner]) => ({ root, owner: isOwner }))
      .sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
    const signature = JSON.stringify(roots);
    if (signature === lastRoots) return;
    lastRoots = signature;
    try {
      opts.onRoots(roots);
    } catch {
      // an observer's failure never stops capture
    }
  };

  const tick = (): void => {
    if (stopped) return;
    let consented: string[];
    try {
      consented = listConsentedRepos(home);
    } catch {
      consented = [];
    }
    const wanted = new Set(consented);
    for (const root of [...extra]) {
      if (isRepoCaptureAllowed(root, home)) wanted.add(root);
      else extra.delete(root);
    }
    for (const root of [...owned]) {
      if (wanted.has(root)) continue;
      releaseCollector(root, owner.token, home);
      forfeit(root);
    }
    known.clear();
    const now = Date.now();
    for (const root of wanted) {
      try {
        if (!tryAcquireCollector(root, owner, home).owner) {
          forfeit(root);
        } else {
          owned.add(root);
          const last = lastPostAt.get(root);
          const due = reconcileEveryTick || last === undefined || now - last >= opts.fullEveryMs;
          if (due && !pending.has(root)) post(root);
        }
      } catch {
        // fail-open: one unreadable repo never stops the others
      }
      known.set(root, owned.has(root));
    }
    ticked = true;
    publishRoots();
  };

  const request = (root: string): void => {
    if (stopped) return;
    const key = normalizeRepoRoot(root);
    if (key.length === 0 || !isRepoCaptureAllowed(key, home)) return;
    extra.add(key);
    try {
      if (!tryAcquireCollector(key, owner, home).owner) {
        forfeit(key);
        known.set(key, false);
      } else {
        owned.add(key);
        known.set(key, true);
        if (pending.has(key)) dirty.add(key);
        else post(key);
      }
    } catch {
      // fail-open: an unreadable repo never stops the others
    }
    publishRoots();
  };

  const timers = new Set<NodeJS.Timeout>();
  const soon = (): void => {
    const t = setTimeout(() => {
      timers.delete(t);
      tick();
    }, 0);
    t.unref();
    timers.add(t);
  };
  const interval = setInterval(tick, tickMs);
  interval.unref();
  soon();

  let outcome: "stopped" | "failed" = "stopped";
  let finish: (result: "stopped" | "failed") => void = () => {};
  const done = new Promise<"stopped" | "failed">((resolve) => {
    finish = resolve;
  });

  let shutdown: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (shutdown) return shutdown;
    stopped = true;
    clearInterval(interval);
    for (const t of timers) clearTimeout(t);
    timers.clear();
    shutdown = worker.terminate().then(() => {
      for (const root of owned) releaseCollector(root, owner.token, home);
      owned.clear();
      extra.clear();
      known.clear();
      pending.clear();
      dirty.clear();
      lastPostAt.clear();
    }).finally(() => finish(outcome));
    return shutdown;
  };
  worker.on("message", (report: ReconcileReport) => {
    pending.delete(report.root);
    try {
      opts.onResult?.(report);
    } catch {
      // an observer's failure never stops capture
    }
    if (dirty.delete(report.root) && !stopped && owned.has(report.root)) post(report.root);
  });
  worker.once("error", (error: Error) => {
    if (!stopped) outcome = "failed";
    say("Capture stopped because the collector worker failed. Existing memory is kept.");
    detail(error.message);
    void stop();
  });
  worker.unref();

  return {
    kick: () => {
      if (!stopped) soon();
    },
    request,
    done,
    stop,
  };
}

function toReport(root: string, result: ReturnType<typeof reconcileRepo>): ReconcileReport {
  const atMs = Date.now();
  const gaps = result.gaps.length;
  if (result.coverage !== "unknown") return { root, coverage: result.coverage, gaps, atMs };
  const first = result.gaps[0];
  const reason = first === "root-unusable" || first === "repo-consent-required" || first === "git-unreadable" || first === "not-a-repo"
    ? first
    : "capture-failed";
  return { root, coverage: "unknown", gaps, reason, atMs };
}

// Lease renewal stays on the HTTP thread; only bounded snapshot work moves.
if (!isMainThread && workerData?.rockyCollector === true) {
  parentPort!.on("message", (root: string) => {
    let report: ReconcileReport;
    try {
      report = toReport(root, reconcileRepo(root, undefined, workerData.home));
    } catch {
      // fail-open: one unreadable repo never stops the others
      report = { root, coverage: "unknown", gaps: 0, reason: "capture-failed", atMs: Date.now() };
    }
    parentPort!.postMessage(report);
  });
}
