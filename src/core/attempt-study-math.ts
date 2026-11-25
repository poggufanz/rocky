export const Z90 = 1.6448536269514722;
export const Z_POWER = 0.8416212335729143;
export const BOOTSTRAP_RESAMPLES = 2000;
export const BOOTSTRAP_SEED = 0x5eed11;

export function wilson(x: number, n: number, z: number): [number, number] {
  if (n <= 0) return [0, 1];
  const p = x / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

export interface DiffInterval {
  diff: number;
  lower: number;
  upper: number;
}

/** Newcombe (1998) method 10: hybrid score interval for p1 - p2. */
export function newcombeDiff(x1: number, n1: number, x2: number, n2: number, z: number): DiffInterval | undefined {
  if (n1 <= 0 || n2 <= 0) return undefined;
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const [l1, u1] = wilson(x1, n1, z);
  const [l2, u2] = wilson(x2, n2, z);
  const diff = p1 - p2;
  return {
    diff,
    lower: diff - Math.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2),
    upper: diff + Math.sqrt((u1 - p1) ** 2 + (p2 - l2) ** 2),
  };
}

/** Two-sided alpha 0.10, power 0.80, normal approximation at pooled p. */
export function mde(n1: number, n2: number, p: number): number | undefined {
  if (n1 <= 0 || n2 <= 0) return undefined;
  return (Z90 + Z_POWER) * Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface StudyCluster {
  arm: "shown" | "held";
  successes: number;
  total: number;
}

/** Percentile interval from resampling sessions with replacement within each arm. */
export function clusterBootstrapDiff(
  clusters: readonly StudyCluster[],
  opts: { resamples: number; seed: number; level: number },
): { lower: number; upper: number } | undefined {
  const shown = clusters.filter((cluster) => cluster.arm === "shown");
  const held = clusters.filter((cluster) => cluster.arm === "held");
  if (shown.length === 0 || held.length === 0) return undefined;

  const rand = mulberry32(opts.seed);
  function resampleRate(arm: readonly StudyCluster[]): number | undefined {
    let successes = 0;
    let total = 0;
    for (let draw = 0; draw < arm.length; draw++) {
      const cluster = arm[Math.floor(rand() * arm.length)]!;
      successes += cluster.successes;
      total += cluster.total;
    }
    return total === 0 ? undefined : successes / total;
  }

  const diffs: number[] = [];
  for (let replicate = 0; replicate < opts.resamples; replicate++) {
    const shownRate = resampleRate(shown);
    const heldRate = resampleRate(held);
    if (shownRate !== undefined && heldRate !== undefined) diffs.push(shownRate - heldRate);
  }

  const count = diffs.length;
  if (count === 0) return undefined;
  diffs.sort((a, b) => a - b);
  return {
    lower: diffs[Math.floor(((1 - opts.level) / 2) * count)]!,
    upper: diffs[Math.ceil(((1 + opts.level) / 2) * count) - 1]!,
  };
}

export function percentileNearestRank(values: readonly number[], q: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(q * sorted.length) - 1];
}
