import { exec } from "node:child_process";
import { isAbsolute, join } from "node:path";

export function signedExit(code: number): number {
  return code > 0x7fffffff ? code - 0x100000000 : code;
}

export function interceptCd(
  input: string,
  cwd: string,
  deps: { exists(p: string): boolean; home(): string },
): { next: string } | { error: string } | undefined {
  const m = input.trim().match(/^cd(?:\s+([^&|;]+))?$/);
  if (!m) return undefined; // compound or not a cd
  const target = (m[1] ?? deps.home()).trim().replace(/^["']|["']$/g, "");
  const next = isAbsolute(target) ? target : join(cwd, target);
  return deps.exists(next) ? { next } : { error: target };
}

export interface RunOutcome {
  displayCode: number;
  out: string[];
  err: string[];
}

export function spawnRun(cmd: string, cwd: string, done: (o: RunOutcome) => void): void {
  exec(cmd, { timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024, cwd }, (error, stdout, stderr) => {
    const tail = (s: string) => String(s).split(/\r?\n/).filter((l) => l !== "").slice(-10);
    const raw = error ? (typeof error.code === "number" ? error.code : 1) : 0;
    done({ displayCode: signedExit(raw), out: tail(stdout), err: tail(stderr) });
  });
}
