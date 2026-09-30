/**
 * GUI-owned collector loop (spec §3, §6). While the foreground GUI lives,
 * every consented repo gets one lease-guarded owner that reconciles on a
 * bounded interval. A process that loses the lease skips that repo; a
 * revoked repo is released and stops capturing, its history stays. MCP
 * never imports this module (mcp-import-boundary): MCP stays read-only.
 */
import { randomBytes } from "node:crypto";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { resolveRockyPaths } from "../core/state-paths.js";
import { detail, say } from "../ui/rocky.js";
import { releaseCollector, tryAcquireCollector, type CollectorOwner } from "./collector.js";
import { listConsentedRepos } from "./repo-consent-read.js";
import { reconcileRepo } from "./watcher.js";

// ponytail: interval reconcile, no fs.watch trigger; add one when edit latency under a tick matters.
// Must stay under COLLECTOR_LEASE_MS (30s): each tick's acquire renews the lease.
export const COLLECTOR_TICK_MS = 10_000;

export interface CollectorLoop {
  /** Run one tick soon, e.g. right after a consent change. */
  kick(): void;
  /** Stop ticking, finish worker shutdown, then release every owned lease. */
  stop(): Promise<void>;
}

export function startCollectorLoop(opts: { proc: CollectorOwner["proc"]; home?: string; tickMs?: number }): CollectorLoop {
  const owner: CollectorOwner = { proc: opts.proc, pid: process.pid, token: randomBytes(16).toString("hex") };
  const home = opts.home ?? resolveRockyPaths().home;
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { rockyCollector: true, home },
    execArgv: [],
  });
  const owned = new Set<string>();
  const pending = new Set<string>();
  let stopped = false;

  const tick = (): void => {
    if (stopped) return;
    let roots: string[];
    try {
      roots = listConsentedRepos(home);
    } catch {
      roots = [];
    }
    const consented = new Set(roots);
    for (const root of [...owned]) {
      if (consented.has(root)) continue;
      releaseCollector(root, owner.token, home);
      owned.delete(root);
    }
    for (const root of roots) {
      try {
        if (!tryAcquireCollector(root, owner, home).owner) {
          owned.delete(root);
          continue;
        }
        owned.add(root);
        if (!pending.has(root)) {
          pending.add(root);
          worker.postMessage(root);
        }
      } catch {
        // fail-open: one unreadable repo never stops the others
      }
    }
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
  const interval = setInterval(tick, opts.tickMs ?? COLLECTOR_TICK_MS);
  interval.unref();
  soon();

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
      pending.clear();
    });
    return shutdown;
  };
  worker.on("message", (root: string) => pending.delete(root));
  worker.once("error", (error: Error) => {
    say("capture stops. bad. memory stays.");
    detail(error.message);
    void stop();
  });
  worker.unref();

  return {
    kick: () => {
      if (!stopped) soon();
    },
    stop,
  };
}

// Lease renewal stays on the HTTP thread; only bounded snapshot work moves.
if (!isMainThread && workerData?.rockyCollector === true) {
  parentPort!.on("message", (root: string) => {
    try {
      reconcileRepo(root, undefined, workerData.home);
    } catch {
      // fail-open: one unreadable repo never stops the others
    } finally {
      parentPort!.postMessage(root);
    }
  });
}
