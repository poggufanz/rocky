export interface BriefFile {
  path: string;
  churn: number;
}

export interface BriefCommit {
  hash: string;
  subject: string;
  files: BriefFile[];
}

export interface BriefMemoryHit {
  kind: "failure" | "fix";
  ts: number;
  cmd: string;
  excerpt?: string;
}

export interface BriefInvariantTouch {
  invariant: string;
  path: string;
}

export interface BriefInput {
  windowLabel: string;
  commits: BriefCommit[];
  memoryHits: BriefMemoryHit[];
  invariantTouches: BriefInvariantTouch[];
}

/** Parse `git log --pretty=format:%H%x09%s --numstat` output. */
export function parseGitLog(stdout: string): BriefCommit[] {
  const commits: BriefCommit[] = [];
  let current: BriefCommit | undefined;
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    const header = /^([0-9a-f]{7,40})\t(.*)$/.exec(line);
    if (header !== null) {
      current = { hash: header[1], subject: header[2], files: [] };
      commits.push(current);
      continue;
    }
    const numstat = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (numstat !== null && current !== undefined) {
      const adds = numstat[1] === "-" ? 0 : Number(numstat[1]);
      const dels = numstat[2] === "-" ? 0 : Number(numstat[2]);
      current.files.push({ path: numstat[3], churn: adds + dels });
    }
  }
  return commits;
}

export function topLevelArea(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.indexOf("/");
  return slash === -1 ? "(root)" : normalized.slice(0, slash);
}

export function composeBrief(input: BriefInput): string[] {
  const lines: string[] = [];
  const allFiles = input.commits.flatMap((commit) => commit.files);
  const uniquePaths = [...new Set(allFiles.map((file) => file.path))];
  const areas = [...new Set(uniquePaths.map(topLevelArea))].sort();

  // Block 1: numbers summary.
  lines.push(`brief window: ${input.windowLabel}`);
  lines.push(`${input.commits.length} commit${input.commits.length === 1 ? "" : "s"}, ${uniquePaths.length} file${uniquePaths.length === 1 ? "" : "s"}. areas: ${areas.length === 0 ? "none" : areas.join(", ")}`);

  // Block 2: changes per area.
  lines.push("changes by area:");
  if (input.commits.length === 0) {
    lines.push("  none");
  } else {
    for (const area of areas) {
      lines.push(`  ${area}:`);
      for (const commit of input.commits) {
        const areaFiles = commit.files.filter((file) => topLevelArea(file.path) === area);
        for (const file of areaFiles) {
          lines.push(`    ${file.path} — ${commit.subject}`);
        }
      }
    }
  }

  // Block 3: linked failures/fixes from memory.
  lines.push("failures and fixes in window:");
  if (input.memoryHits.length === 0) {
    lines.push("  none remembered");
  } else {
    for (const hit of [...input.memoryHits].sort((a, b) => a.ts - b.ts)) {
      lines.push(`  ${hit.kind}: ${hit.cmd}${hit.excerpt === undefined ? "" : ` — ${hit.excerpt}`}`);
    }
  }

  // Block 4: invariant intersections.
  for (const touch of input.invariantTouches) {
    lines.push(`${touch.path} changed. this path guards: "${touch.invariant}". worth checking, question`);
  }

  // Block 5: explain-ready questions from deterministic templates.
  lines.push("explain-ready:");
  if (areas.length === 0) {
    lines.push("  nothing to explain. quiet window.");
  } else {
    for (const area of areas) {
      lines.push(`  why ${area} change, question`);
    }
    const biggest = [...allFiles].sort((a, b) => b.churn - a.churn || a.path.localeCompare(b.path))[0];
    if (biggest !== undefined && biggest.churn > 0) {
      lines.push(`  what impact of ${biggest.path} change, question`);
    }
  }
  return lines;
}
