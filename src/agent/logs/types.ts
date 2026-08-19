/** Canonical rationale event shared by every agent log adapter. */
export interface CanonicalRationaleEvent {
  agent: "claude-code" | "dsh";
  sessionId: string;
  turnRef: string;
  ts: number;
  cwd?: string;
  text: string;
  fidelity: "raw" | "summary";
  source: "log-thinking" | "log-response";
  logPath: string;
  /**
   * Files touched by Edit/Write/MultiEdit tool calls in the same turn as
   * this event, when the adapter can see them. Used only for structural
   * correlation in the capture pipeline; absent (not empty) when the
   * adapter carries no file information at all (e.g. dsh).
   */
  touchedFiles?: string[];
}

/** One agent's log discovery and incremental scan surface. Never throws. */
export interface LogAdapter {
  agent: CanonicalRationaleEvent["agent"];
  /** Candidate log files for a repo; never throws. */
  discover(repoCwd: string): string[];
  /**
   * Incrementally scan one log file from `fromOffset`, emitting only events
   * with seq/position past it. For line-seekable formats (`.jsonl`) offsets
   * are byte offsets; for whole-file formats (`.zstd`) offsets carry the
   * last-seen event `seq` instead. Transcript logs mix sessions from many
   * repos, so line-seekable adapters emit only events that belong to
   * `repoCwd`; DSH records carry no cwd, so the dsh adapter accepts
   * `repoCwd` but does not repo-scope its events.
   * Never throws.
   */
  scan(repoCwd: string, logPath: string, fromOffset: number, maxBytes: number): { events: CanonicalRationaleEvent[]; nextOffset: number };
}
