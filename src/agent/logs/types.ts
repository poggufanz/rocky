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
}

/** One agent's log discovery and incremental scan surface. Never throws. */
export interface LogAdapter {
  agent: CanonicalRationaleEvent["agent"];
  /** Candidate log files for a repo; never throws. */
  discover(repoCwd: string): string[];
  scan(logPath: string, fromOffset: number, maxBytes: number): { events: CanonicalRationaleEvent[]; nextOffset: number };
}
